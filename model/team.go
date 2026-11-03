package model

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	ErrTeamAccess     = errors.New("Team access denied")
	ErrTeamInput      = errors.New("Invalid team settings")
	ErrTeamInvitation = errors.New("Team invitation is unavailable")
	ErrTeamOperation  = errors.New("Team balance operation conflicts with an earlier request")
	ErrTeamMembership = errors.New("This user already belongs to another team")
	ErrTeamDemotion   = errors.New("Remove extra team memberships before demoting this administrator")
)

type Team struct {
	AllowPersonalBackup bool   `json:"allow_personal_backup"`
	ID                  int    `json:"id"`
	Name                string `json:"name" gorm:"type:varchar(128);not null"`
	Status              int    `json:"status"`
	Balance             int64  `json:"balance" gorm:"type:bigint;not null;default:0"`
	DailyLimit          *int64 `json:"daily_limit" gorm:"type:bigint"`
	WeeklyLimit         *int64 `json:"weekly_limit" gorm:"type:bigint"`
	CreatedAt           int64  `json:"created_at" gorm:"type:bigint"`
	UpdatedAt           int64  `json:"updated_at" gorm:"type:bigint"`
}

// Removed memberships remain stored for history but are excluded from member lists.
const TeamMemberStatusRemoved = 3

type TeamMember struct {
	ID        int    `json:"id"`
	TeamID    int    `json:"team_id" gorm:"uniqueIndex:idx_team_member;index"`
	UserID    int    `json:"user_id" gorm:"uniqueIndex:idx_team_member;index"`
	Role      string `json:"role" gorm:"type:varchar(16)"`
	Status    int    `json:"status"`
	CreatedAt int64  `json:"created_at" gorm:"type:bigint"`
}
type TeamInvitation struct {
	ID         int    `json:"id"`
	TeamID     int    `json:"team_id" gorm:"index"`
	TokenHash  string `json:"-" gorm:"type:varchar(64);uniqueIndex"`
	CreatedBy  int    `json:"created_by"`
	CreatedAt  int64  `json:"created_at" gorm:"type:bigint"`
	ExpiresAt  int64  `json:"expired_at" gorm:"type:bigint"`
	RevokedAt  int64  `json:"revoked_at" gorm:"type:bigint"`
	AcceptedBy int    `json:"used_by"`
	AcceptedAt int64  `json:"used_at" gorm:"type:bigint"`
}
type TeamBalanceOperation struct {
	ID          int    `json:"id"`
	TeamID      int    `json:"team_id" gorm:"index;uniqueIndex:idx_team_balance_operation"`
	OperationID string `json:"operation_id" gorm:"type:varchar(128);uniqueIndex:idx_team_balance_operation"`
	ActorID     int    `json:"actor_id"`
	Mode        string `json:"mode" gorm:"type:varchar(16)"`
	Value       int64  `json:"value" gorm:"type:bigint"`
	Before      int64  `json:"balance_before" gorm:"type:bigint"`
	After       int64  `json:"balance_after" gorm:"type:bigint"`
	Reason      string `json:"reason" gorm:"type:varchar(512)"`
	CreatedAt   int64  `json:"created_at" gorm:"type:bigint"`
}

// Management events are committed in the same transaction as the mutation.
// Snapshots contain only team/member/invitation metadata, never invitation secrets.
type TeamManagementEvent struct {
	ID        int    `json:"id"`
	TeamID    int    `json:"team_id" gorm:"index"`
	ActorID   int    `json:"actor_id"`
	Action    string `json:"action" gorm:"type:varchar(64)"`
	Before    string `json:"before" gorm:"type:text"`
	After     string `json:"after" gorm:"type:text"`
	CreatedAt int64  `json:"created_at" gorm:"type:bigint"`
}
type TeamCreate struct {
	AllowPersonalBackup *bool  `json:"allow_personal_backup"`
	Name                string `json:"name"`
	AdminUserID         int    `json:"admin_user_id"`
	DailyLimit          *int64 `json:"daily_limit"`
	WeeklyLimit         *int64 `json:"weekly_limit"`
}
type TeamUpdate struct {
	AllowPersonalBackup *bool           `json:"allow_personal_backup"`
	Name                *string         `json:"name"`
	Status              *int            `json:"status"`
	AdminUserID         *int            `json:"admin_user_id"`
	DailyLimit          json.RawMessage `json:"daily_limit"`
	WeeklyLimit         json.RawMessage `json:"weekly_limit"`
}
type VisibleTeam struct {
	Team
	Role string `json:"role"`
}
type TeamMemberView struct {
	TeamMember
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

func MigrateTeams(db *gorm.DB) error {
	addBackupSetting := !db.Migrator().HasColumn(&Team{}, "allow_personal_backup")
	if err := db.AutoMigrate(&Team{}, &TeamMember{}, &TeamInvitation{}, &TeamBalanceOperation{}, &TeamManagementEvent{}); err != nil {
		return err
	}
	if addBackupSetting {
		return db.Model(&Team{}).Where("1 = 1").Update("allow_personal_backup", true).Error
	}
	return nil
}
func teamEvent(tx *gorm.DB, teamID, actorID int, action string, before, after any) error {
	b, err := common.Marshal(before)
	if err != nil {
		return err
	}
	a, err := common.Marshal(after)
	if err != nil {
		return err
	}
	return tx.Create(&TeamManagementEvent{TeamID: teamID, ActorID: actorID, Action: action, Before: string(b), After: string(a), CreatedAt: time.Now().Unix()}).Error
}
func teamActor(tx *gorm.DB, userID, globalRole int) (*User, error) {
	var user User
	if userID <= 0 || tx.First(&user, userID).Error != nil || user.Status != common.UserStatusEnabled {
		return nil, ErrTeamAccess
	}
	user.Role = min(user.Role, globalRole)
	return &user, nil
}

// teamMembershipUser serializes membership changes across teams on the persisted user.
// Existing teams must be locked first; new teams are created only after this lock.
func teamMembershipUser(tx *gorm.DB, userID int) (*User, error) {
	var user User
	if err := lockForUpdate(tx).First(&user, userID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrTeamInput
		}
		return nil, err
	}
	return &user, nil
}

// requireSingleTeamMembership needs the user lock held through the transaction.
func requireSingleTeamMembership(tx *gorm.DB, user *User, teamID int) error {
	if user.Status != common.UserStatusEnabled {
		return ErrTeamInput
	}
	if user.Role >= common.RoleAdminUser {
		return nil
	}
	var other []TeamMember
	// Use a current locking read, including on MySQL's repeatable-read isolation:
	// authorization reads may already have established an older snapshot.
	if err := lockForUpdate(tx).Where("user_id = ? AND status = ? AND team_id <> ?", user.Id, 1, teamID).Limit(1).Find(&other).Error; err != nil {
		return err
	}
	if len(other) != 0 {
		return ErrTeamMembership
	}
	return nil
}

// teamAccess permits managers to administer disabled teams; billing must additionally check Status.
func teamAccess(tx *gorm.DB, teamID, userID, globalRole int, manager bool) (*Team, string, error) {
	user, err := teamActor(tx, userID, globalRole)
	if err != nil {
		return nil, "", err
	}
	var team Team
	if err = tx.First(&team, teamID).Error; err != nil {
		return nil, "", ErrTeamAccess
	}
	if user.Role >= common.RoleAdminUser {
		return &team, "system", nil
	}
	var member TeamMember
	if tx.Where("team_id = ? AND user_id = ? AND status = ?", teamID, userID, 1).First(&member).Error != nil {
		return nil, "", ErrTeamAccess
	}
	if manager && member.Role != "admin" {
		return nil, "", ErrTeamAccess
	}
	if team.Status != 1 && member.Role != "admin" {
		return nil, "", ErrTeamAccess
	}
	return &team, member.Role, nil
}
func RequireTeamAccess(teamID, userID, globalRole int, manager bool) error {
	_, _, err := teamAccess(DB, teamID, userID, globalRole, manager)
	return err
}
func GetTeam(teamID, userID, globalRole int) (*Team, string, error) {
	return teamAccess(DB, teamID, userID, globalRole, false)
}
func ListTeams(userID, globalRole int) ([]VisibleTeam, error) {
	user, err := teamActor(DB, userID, globalRole)
	if err != nil {
		return nil, err
	}
	rows := make([]VisibleTeam, 0)
	if user.Role >= common.RoleAdminUser {
		var teams []Team
		if err = DB.Order("id").Find(&teams).Error; err != nil {
			return nil, err
		}
		for _, t := range teams {
			rows = append(rows, VisibleTeam{Team: t, Role: "system"})
		}
		return rows, nil
	}
	err = DB.Model(&Team{}).Select("teams.*, team_members.role").Joins("JOIN team_members ON team_members.team_id = teams.id").Where("team_members.user_id = ? AND team_members.status = ? AND (teams.status = ? OR team_members.role = ?)", userID, 1, 1, "admin").Order("teams.id").Scan(&rows).Error
	return rows, err
}
func validTeamLimit(v *int64) bool {
	return v == nil || (*v >= 0 && *v <= int64(common.MaxWalletQuota))
}
func CreateTeam(actorID, globalRole int, input TeamCreate) (*Team, error) {
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || utf8.RuneCountInString(input.Name) > 128 || !validTeamLimit(input.DailyLimit) || !validTeamLimit(input.WeeklyLimit) {
		return nil, ErrTeamInput
	}
	var team Team
	err := DB.Transaction(func(tx *gorm.DB) error {
		actor, err := teamActor(tx, actorID, globalRole)
		if err != nil || actor.Role < common.RoleAdminUser {
			return ErrTeamAccess
		}
		admin, err := teamMembershipUser(tx, input.AdminUserID)
		if err != nil {
			return err
		}
		if err = requireSingleTeamMembership(tx, admin, 0); err != nil {
			return err
		}
		now := time.Now().Unix()
		allowBackup := true
		if input.AllowPersonalBackup != nil {
			allowBackup = *input.AllowPersonalBackup
		}
		team = Team{AllowPersonalBackup: allowBackup, Name: input.Name, Status: 1, DailyLimit: input.DailyLimit, WeeklyLimit: input.WeeklyLimit, CreatedAt: now, UpdatedAt: now}
		if err = tx.Create(&team).Error; err != nil {
			return err
		}
		if err = tx.Create(&TeamMember{TeamID: team.ID, UserID: input.AdminUserID, Role: "admin", Status: 1, CreatedAt: now}).Error; err != nil {
			return err
		}
		return teamEvent(tx, team.ID, actorID, "team.create", nil, map[string]any{"team": team, "admin_user_id": input.AdminUserID})
	})
	return &team, err
}
func UpdateTeam(teamID, actorID, globalRole int, input TeamUpdate) (*Team, error) {
	var result *Team
	err := DB.Transaction(func(tx *gorm.DB) error {
		var locked Team
		if err := lockForUpdate(tx).First(&locked, teamID).Error; err != nil {
			return ErrTeamAccess
		}
		team, role, err := teamAccess(tx, teamID, actorID, globalRole, true)
		if err != nil {
			return err
		}
		if role != "system" && (input.Status != nil || input.AdminUserID != nil || input.AllowPersonalBackup != nil) {
			return ErrTeamAccess
		}
		updates := map[string]any{"updated_at": time.Now().Unix()}
		if input.AllowPersonalBackup != nil {
			updates["allow_personal_backup"] = *input.AllowPersonalBackup
		}
		if input.Name != nil {
			n := strings.TrimSpace(*input.Name)
			if n == "" || utf8.RuneCountInString(n) > 128 {
				return ErrTeamInput
			}
			updates["name"] = n
		}
		if input.Status != nil {
			if *input.Status != 1 && *input.Status != 2 {
				return ErrTeamInput
			}
			updates["status"] = *input.Status
		}
		for field, raw := range map[string]json.RawMessage{"daily_limit": input.DailyLimit, "weekly_limit": input.WeeklyLimit} {
			if len(raw) == 0 {
				continue
			}
			var value *int64
			if common.Unmarshal(raw, &value) != nil || !validTeamLimit(value) {
				return ErrTeamInput
			}
			updates[field] = value
		}
		if input.AdminUserID != nil {
			admin, err := teamMembershipUser(tx, *input.AdminUserID)
			if err != nil {
				return err
			}
			if err = requireSingleTeamMembership(tx, admin, teamID); err != nil {
				return err
			}
			var previousAdmins []TeamMember
			if err = tx.Where("team_id = ? AND role = ?", teamID, "admin").Find(&previousAdmins).Error; err != nil {
				return err
			}
			if err = teamEvent(tx, teamID, actorID, "team.admin.appoint", previousAdmins, map[string]any{"admin_user_id": *input.AdminUserID}); err != nil {
				return err
			}
			if err = tx.Model(&TeamMember{}).Where("team_id = ? AND role = ?", teamID, "admin").Update("role", "member").Error; err != nil {
				return err
			}
			m := TeamMember{TeamID: teamID, UserID: *input.AdminUserID, Role: "admin", Status: 1, CreatedAt: time.Now().Unix()}
			if err = tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "team_id"}, {Name: "user_id"}}, DoUpdates: clause.Assignments(map[string]any{"role": "admin", "status": 1})}).Create(&m).Error; err != nil {
				return err
			}
		}
		if err = tx.Model(&Team{}).Where("id = ?", teamID).Updates(updates).Error; err != nil {
			return err
		}
		var after Team
		if err = tx.First(&after, teamID).Error; err != nil {
			return err
		}
		result = &after
		return teamEvent(tx, teamID, actorID, "team.update", team, map[string]any{"team": after, "admin_user_id": input.AdminUserID})
	})
	return result, err
}
func ListTeamMembers(teamID, actorID, globalRole int) ([]TeamMemberView, error) {
	if err := RequireTeamAccess(teamID, actorID, globalRole, true); err != nil {
		return nil, err
	}
	rows := make([]TeamMemberView, 0)
	err := DB.Model(&TeamMember{}).Select("team_members.*, users.username, users.display_name").Joins("JOIN users ON users.id = team_members.user_id").Where("team_members.team_id = ? AND team_members.status <> ?", teamID, TeamMemberStatusRemoved).Order("team_members.id").Scan(&rows).Error
	return rows, err
}
func UpdateTeamMember(teamID, actorID, userID, globalRole int, role *string, status *int, remove bool) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var team Team
		if err := lockForUpdate(tx).First(&team, teamID).Error; err != nil {
			return ErrTeamAccess
		}
		_, actorRole, err := teamAccess(tx, teamID, actorID, globalRole, true)
		if err != nil {
			return err
		}
		user, err := teamMembershipUser(tx, userID)
		if err != nil {
			return err
		}
		var before TeamMember
		if err = lockForUpdate(tx).Where("team_id = ? AND user_id = ?", teamID, userID).First(&before).Error; err != nil {
			return ErrTeamAccess
		}
		if actorRole != "system" && (before.Role != "member" || role != nil) {
			return ErrTeamAccess
		}
		updates := map[string]any{}
		if role != nil {
			if *role != "admin" && *role != "member" {
				return ErrTeamInput
			}
			updates["role"] = *role
		}
		if status != nil {
			if *status != 1 && *status != 2 {
				return ErrTeamInput
			}
			updates["status"] = *status
		}
		if remove {
			updates["status"] = TeamMemberStatusRemoved
		}
		active := before.Status == 1
		if next, ok := updates["status"].(int); ok {
			active = next == 1
		}
		if active {
			if err = requireSingleTeamMembership(tx, user, teamID); err != nil {
				return err
			}
		}
		if err = tx.Model(&TeamMember{}).Where("id = ?", before.ID).Updates(updates).Error; err != nil {
			return err
		}
		var after TeamMember
		if err = tx.First(&after, before.ID).Error; err != nil {
			return err
		}
		action := "team.member.update"
		if remove {
			action = "team.member.remove"
		}
		return teamEvent(tx, teamID, actorID, action, before, after)
	})
}
func AdjustTeamBalance(teamID, actorID, globalRole int, mode string, value int64, reason, operationID string) (*TeamBalanceOperation, error) {
	reason = strings.TrimSpace(reason)
	operationID = strings.TrimSpace(operationID)
	if value < 0 || value > int64(common.MaxWalletQuota) || reason == "" || utf8.RuneCountInString(reason) > 512 || operationID == "" || len(operationID) > 128 {
		return nil, ErrTeamInput
	}
	if mode != "add" && mode != "subtract" && mode != "override" {
		return nil, ErrTeamInput
	}
	var result TeamBalanceOperation
	err := DB.Transaction(func(tx *gorm.DB) error {
		var team Team
		if err := lockForUpdate(tx).First(&team, teamID).Error; err != nil {
			return ErrTeamAccess
		}
		_, role, err := teamAccess(tx, teamID, actorID, globalRole, true)
		if err != nil || role != "system" {
			return ErrTeamAccess
		}
		err = tx.Where("team_id = ? AND operation_id = ?", teamID, operationID).First(&result).Error
		if err == nil {
			if result.ActorID != actorID || result.Mode != mode || result.Value != value || result.Reason != reason {
				return ErrTeamOperation
			}
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		balance := value
		if mode == "add" {
			if team.Balance > int64(common.MaxWalletQuota)-value {
				return ErrTeamInput
			}
			balance = team.Balance + value
		}
		if mode == "subtract" {
			if value > team.Balance {
				return ErrTeamInput
			}
			balance = team.Balance - value
		}
		liability, err := GetTeamRefundLiability(tx, teamID)
		if err != nil {
			return err
		}
		// Pending charges may be refunded, so keep their wallet capacity available.
		if balance < 0 || liability < 0 || liability > int64(common.MaxWalletQuota) || balance > int64(common.MaxWalletQuota)-liability {
			return ErrTeamInput
		}
		result = TeamBalanceOperation{TeamID: teamID, ActorID: actorID, OperationID: operationID, Mode: mode, Value: value, Before: team.Balance, After: balance, Reason: reason, CreatedAt: time.Now().Unix()}
		if err = tx.Create(&result).Error; err != nil {
			return err
		}
		return tx.Model(&Team{}).Where("id = ?", teamID).Updates(map[string]any{"balance": balance, "updated_at": time.Now().Unix()}).Error
	})
	return &result, err
}
func ListTeamBalanceOperations(teamID, actorID, globalRole int) ([]TeamBalanceOperation, error) {
	if err := RequireTeamAccess(teamID, actorID, globalRole, true); err != nil {
		return nil, err
	}
	rows := make([]TeamBalanceOperation, 0)
	err := DB.Where("team_id = ?", teamID).Order("id desc").Limit(1000).Find(&rows).Error
	return rows, err
}
func CreateTeamInvitation(teamID, actorID, globalRole, validDays int) (*TeamInvitation, string, error) {
	if validDays == 0 {
		validDays = 7
	}
	if validDays < 1 || validDays > 30 {
		return nil, "", ErrTeamInput
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, "", err
	}
	raw := base64.RawURLEncoding.EncodeToString(secret)
	digest := sha256.Sum256([]byte(raw))
	invite := TeamInvitation{TeamID: teamID, TokenHash: hex.EncodeToString(digest[:]), CreatedBy: actorID, CreatedAt: time.Now().Unix(), ExpiresAt: time.Now().Add(time.Duration(validDays) * 24 * time.Hour).Unix()}
	err := DB.Transaction(func(tx *gorm.DB) error {
		var team Team
		if err := lockForUpdate(tx).First(&team, teamID).Error; err != nil {
			return ErrTeamAccess
		}
		if _, _, err := teamAccess(tx, teamID, actorID, globalRole, true); err != nil {
			return err
		}
		if err := tx.Create(&invite).Error; err != nil {
			return err
		}
		return teamEvent(tx, teamID, actorID, "team.invitation.create", nil, invite)
	})
	if err != nil {
		return nil, "", err
	}
	return &invite, raw, nil
}

// TeamInvitationView adds identity to the management list without changing the
// public preview or exposing the stored token digest.
type TeamInvitationView struct {
	TeamInvitation
	AcceptedUsername string `json:"accepted_username"`
}

func ListTeamInvitations(teamID, actorID, globalRole int) ([]TeamInvitationView, error) {
	if err := RequireTeamAccess(teamID, actorID, globalRole, true); err != nil {
		return nil, err
	}
	rows := make([]TeamInvitationView, 0)
	err := DB.Model(&TeamInvitation{}).
		Joins("LEFT JOIN users ON users.id = team_invitations.accepted_by").
		Select("team_invitations.*, COALESCE(users.username, '') AS accepted_username").
		Where("team_invitations.team_id = ?", teamID).Order("team_invitations.id DESC").Limit(1000).Find(&rows).Error
	return rows, err
}
func RevokeTeamInvitation(teamID, inviteID, actorID, globalRole int) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var team Team
		if err := lockForUpdate(tx).First(&team, teamID).Error; err != nil {
			return ErrTeamAccess
		}
		if _, _, err := teamAccess(tx, teamID, actorID, globalRole, true); err != nil {
			return err
		}
		var invite TeamInvitation
		if err := lockForUpdate(tx).Where("id = ? AND team_id = ?", inviteID, teamID).First(&invite).Error; err != nil {
			return ErrTeamInvitation
		}
		if invite.RevokedAt != 0 {
			return nil
		}
		before := invite
		invite.RevokedAt = time.Now().Unix()
		if err := tx.Model(&invite).Update("revoked_at", invite.RevokedAt).Error; err != nil {
			return err
		}
		return teamEvent(tx, teamID, actorID, "team.invitation.revoke", before, invite)
	})
}
func PreviewTeamInvitation(raw string) (*Team, *TeamInvitation, string, error) {
	if len(raw) != 43 {
		return nil, nil, "", ErrTeamInvitation
	}
	digest := sha256.Sum256([]byte(raw))
	var invite TeamInvitation
	if DB.Where("token_hash = ?", hex.EncodeToString(digest[:])).First(&invite).Error != nil {
		return nil, nil, "", ErrTeamInvitation
	}
	var team Team
	if DB.First(&team, invite.TeamID).Error != nil {
		return nil, nil, "", ErrTeamInvitation
	}
	state := "active"
	if invite.AcceptedBy != 0 {
		state = "accepted"
	}
	if invite.ExpiresAt <= time.Now().Unix() {
		state = "expired"
	}
	if invite.RevokedAt != 0 {
		state = "revoked"
	}
	if team.Status != 1 {
		state = "disabled"
	}
	return &team, &invite, state, nil
}
func AcceptTeamInvitation(raw string, userID int) (*TeamMember, error) {
	if len(raw) != 43 {
		return nil, ErrTeamInvitation
	}
	digest := sha256.Sum256([]byte(raw))
	hash := hex.EncodeToString(digest[:])
	var result TeamMember
	err := DB.Transaction(func(tx *gorm.DB) error {
		if _, err := teamActor(tx, userID, 100); err != nil {
			return err
		}
		var invite TeamInvitation
		if tx.Where("token_hash = ?", hash).First(&invite).Error != nil {
			return ErrTeamInvitation
		}
		var team Team
		if lockForUpdate(tx).First(&team, invite.TeamID).Error != nil || team.Status != 1 {
			return ErrTeamInvitation
		}
		if err := lockForUpdate(tx).First(&invite, invite.ID).Error; err != nil {
			return err
		}
		user, err := teamMembershipUser(tx, userID)
		if err != nil {
			return err
		}
		if err = requireSingleTeamMembership(tx, user, team.ID); err != nil {
			return err
		}
		if invite.AcceptedBy == userID {
			if lockForUpdate(tx).Where("team_id = ? AND user_id = ? AND status = ?", invite.TeamID, userID, 1).First(&result).Error != nil {
				return ErrTeamAccess
			}
			return nil
		}
		now := time.Now().Unix()
		if invite.AcceptedBy != 0 || invite.RevokedAt != 0 || invite.ExpiresAt <= now {
			return ErrTeamInvitation
		}
		update := tx.Model(&TeamInvitation{}).Where("id = ? AND accepted_by = ? AND revoked_at = ? AND expires_at > ?", invite.ID, 0, 0, now).Updates(map[string]any{"accepted_by": userID, "accepted_at": now})
		if update.Error != nil {
			return update.Error
		}
		if update.RowsAffected != 1 {
			return ErrTeamInvitation
		}
		result = TeamMember{TeamID: team.ID, UserID: userID, Role: "member", Status: 1, CreatedAt: now}
		// Preserve active roles. A disabled member requires an explicit manager action.
		err = lockForUpdate(tx).Where("team_id = ? AND user_id = ?", team.ID, userID).First(&result).Error
		if err == nil {
			if result.Status == TeamMemberStatusRemoved {
				// A new invitation restores membership, never the former administrator role.
				if err = tx.Model(&result).Updates(map[string]any{"role": "member", "status": 1, "created_at": now}).Error; err != nil {
					return err
				}
				result.Role, result.Status, result.CreatedAt = "member", 1, now
			} else if result.Status != 1 {
				return ErrTeamAccess
			}
		} else if errors.Is(err, gorm.ErrRecordNotFound) {
			result = TeamMember{TeamID: team.ID, UserID: userID, Role: "member", Status: 1, CreatedAt: now}
			if err = tx.Create(&result).Error; err != nil {
				return err
			}
		} else {
			return err
		}
		return teamEvent(tx, team.ID, userID, "team.invitation.accept", nil, map[string]any{"invitation_id": invite.ID, "member": result})
	})
	return &result, err
}
