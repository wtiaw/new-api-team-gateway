package model

import (
	"errors"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm/clause"
)

type TeamKeyPolicy struct {
	TokenID         int    `json:"token_id" gorm:"primaryKey;autoIncrement:false"`
	UserID          int    `json:"user_id" gorm:"index"`
	TeamID          int    `json:"team_id" gorm:"index"`
	Mode            string `json:"mode" gorm:"type:varchar(32)"`
	IsDefault       bool   `json:"is_default" gorm:"-"`
	TeamName        string `json:"team_name,omitempty" gorm:"-"`
	ResourceGroup   string `json:"resource_group,omitempty" gorm:"-"`
	ResolutionError string `json:"resolution_error,omitempty" gorm:"-"`
}

// DefaultTeamKeyPolicy follows an actual active membership, never the list of
// teams a system administrator is merely allowed to manage.
func DefaultTeamKeyPolicy(userID int) (*TeamKeyPolicy, error) {
	return DefaultTeamKeyPolicyForGroup(userID, "")
}

func DefaultTeamKeyPolicyForGroup(userID int, group string) (*TeamKeyPolicy, error) {
	teams, native, err := ActiveTeamGroupProfiles(userID)
	if err != nil {
		return nil, err
	}
	policy := projectTeamKeyPolicy(TeamKeyPolicy{UserID: userID, Mode: "legacy", IsDefault: true}, group, teams, native)
	return &policy, nil
}

// Derive ownership for every read, including explicit personal-only policies.
// An unresolvable row stays editable instead of failing the entire key listing.
func projectTeamKeyPolicy(policy TeamKeyPolicy, group string, teams []Team, native bool) TeamKeyPolicy {
	team, _, err := matchActiveTeamGroupProfile(teams, native, policy.TeamID, group)
	policy.TeamID, policy.TeamName, policy.ResourceGroup, policy.ResolutionError = 0, "", "", ""
	if err != nil {
		policy.ResolutionError = err.Error()
		return policy
	}
	if team == nil {
		return policy
	}
	policy.TeamID, policy.TeamName, policy.ResourceGroup = team.ID, team.Name, group
	if group == "" {
		policy.ResourceGroup = team.DefaultGroup
		if policy.ResourceGroup == "" && len(team.AllowedGroups) == 1 {
			policy.ResourceGroup = team.AllowedGroups[0]
		}
	}
	if policy.Mode == "legacy" {
		policy.Mode = "team_first"
		if !team.AllowPersonalBackup {
			policy.Mode = "team_only"
		}
	}
	return policy
}

// GetTeamKeyPolicies batches list-page policies rather than querying each row.
func GetTeamKeyPolicies(tokens []*Token, userID int) (map[int]*TeamKeyPolicy, error) {
	result := make(map[int]*TeamKeyPolicy, len(tokens))
	if len(tokens) == 0 {
		return result, nil
	}
	ids := make([]int, 0, len(tokens))
	for _, token := range tokens {
		if token == nil || token.UserId != userID {
			return nil, ErrTeamFundingForbidden
		}
		ids = append(ids, token.Id)
	}
	var policies []TeamKeyPolicy
	if err := DB.Where("user_id = ? AND token_id IN ?", userID, ids).Find(&policies).Error; err != nil {
		return nil, err
	}
	for i := range policies {
		result[policies[i].TokenID] = &policies[i]
	}
	teams, native, err := ActiveTeamGroupProfiles(userID)
	if err != nil {
		return nil, err
	}
	for _, token := range tokens {
		policy := TeamKeyPolicy{TokenID: token.Id, UserID: userID, Mode: "legacy", IsDefault: true}
		if stored := result[token.Id]; stored != nil {
			policy = *stored
		}
		projected := projectTeamKeyPolicy(policy, token.Group, teams, native)
		result[token.Id] = &projected
	}
	return result, nil
}

func GetTeamKeyPolicy(tokenID, userID int) (*TeamKeyPolicy, error) {
	var token Token
	if err := DB.Where("id = ? AND user_id = ?", tokenID, userID).First(&token).Error; err != nil {
		return nil, err
	}
	policies, err := GetTeamKeyPolicies([]*Token{&token}, userID)
	return policies[tokenID], err
}

func SetTeamKeyPolicy(tokenID, userID int, policy TeamKeyPolicy) error {
	var token Token
	if err := DB.Where("id = ? AND user_id = ?", tokenID, userID).First(&token).Error; err != nil {
		return err
	}
	if policy.Mode == "legacy" {
		return DB.Where("token_id = ? AND user_id = ?", tokenID, userID).Delete(&TeamKeyPolicy{}).Error
	}
	switch policy.Mode {
	case "personal_only", "team_only", "team_first", "personal_first":
	default:
		return ErrTeamFundingState
	}
	team, native, err := MatchTeamGroupProfile(userID, 0, token.Group)
	if err != nil {
		return err
	}
	if team == nil {
		if !native || policy.Mode != "personal_only" || policy.TeamID != 0 {
			return ErrTeamAccess
		}
	} else {
		if policy.TeamID != 0 && policy.TeamID != team.ID {
			return ErrTeamAccess
		}
		policy.TeamID = team.ID
		if (policy.Mode == "team_first" || policy.Mode == "personal_first") && !team.AllowPersonalBackup {
			return ErrTeamPersonalBackupDisabled
		}
	}
	policy.TokenID, policy.UserID = tokenID, userID
	return DB.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "token_id"}}, DoUpdates: clause.AssignmentColumns([]string{"user_id", "team_id", "mode"})}).Create(&policy).Error
}

func IsTeamFundingExhausted(err error) bool {
	return errors.Is(err, ErrTeamBalance) || errors.Is(err, ErrTeamDailyLimit) || errors.Is(err, ErrTeamWeeklyLimit)
}

// Native global administrators can manage all teams; membership never grants global role.
func TeamFundingPolicyUserRole(userID int) (int, error) {
	var user User
	err := DB.First(&user, userID).Error
	if err != nil {
		return 0, err
	}
	if user.Status != common.UserStatusEnabled {
		return 0, ErrTeamFundingForbidden
	}
	return user.Role, nil
}
