package model

import (
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

var (
	ErrTeamBalance                = errors.New("Team balance is insufficient")
	ErrTeamDailyLimit             = errors.New("Member daily team allowance reached")
	ErrTeamWeeklyLimit            = errors.New("Member weekly team allowance reached")
	ErrTeamFundingForbidden       = errors.New("Team funding is not authorized")
	ErrTeamFundingState           = errors.New("Invalid team funding operation")
	ErrTeamPersonalBackupDisabled = errors.New("Personal backup is disabled for this team")
)

// TeamFundingReservation is the durable source and original-period snapshot.
// Wallet balance excludes Reserved while in flight; Actual is charged at settlement.
type TeamFundingReservation struct {
	UsingGroup       string `json:"using_group,omitempty" gorm:"type:varchar(128)"`
	ChannelID        int    `json:"channel_id,omitempty"`
	ChannelName      string `json:"channel_name,omitempty" gorm:"type:varchar(255)"`
	RequestID        string `json:"request_id" gorm:"primaryKey;type:varchar(128)"`
	TeamID           int    `json:"team_id" gorm:"index:idx_team_funding_period"`
	UserID           int    `json:"user_id" gorm:"index"`
	TokenID          int    `json:"token_id"`
	Source           string `json:"source" gorm:"type:varchar(16)"`
	ModelName        string `json:"model_name" gorm:"type:varchar(255)"`
	Reserved         int64  `json:"reserved"`
	Actual           int64  `json:"actual"`
	State            string `json:"state" gorm:"type:varchar(16)"`
	DayStart         int64  `json:"day_start" gorm:"index:idx_team_funding_period"`
	WeekStart        int64  `json:"week_start" gorm:"index"`
	CreatedAt        int64  `json:"created_at"`
	PromptTokens     int    `json:"prompt_tokens"`
	CompletionTokens int    `json:"completion_tokens"`
	FallbackReason   string `json:"fallback_reason" gorm:"type:varchar(128)"`
	Overrun          bool   `json:"overrun"`
	HardLimited      bool   `json:"hard_limited"`
	Postpaid         bool   `json:"postpaid"`
	Refundable       bool   `json:"-"`
}

type TeamBudgetSummary struct {
	DailyUsed      int64 `json:"daily_used"`
	DailyReserved  int64 `json:"daily_reserved"`
	WeeklyUsed     int64 `json:"weekly_used"`
	WeeklyReserved int64 `json:"weekly_reserved"`
	DayStart       int64 `json:"day_start"`
	WeekStart      int64 `json:"week_start"`
}

func MigrateTeamFunding(db *gorm.DB) error {
	return db.AutoMigrate(&TeamKeyPolicy{}, &TeamFundingReservation{})
}

func teamPeriodStarts(now int64) (int64, int64) {
	// A fixed IANA offset is correct for the supported Asia/Shanghai budget calendar.
	t := time.Unix(now, 0).In(time.FixedZone("Asia/Shanghai", 8*3600))
	day := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
	return day.Unix(), day.AddDate(0, 0, -(int(day.Weekday())+6)%7).Unix()
}

// Management totals aggregate the shared wallet's usage, never its member caps.
func teamBudgetSummary(tx *gorm.DB, teamID int, now int64) (*TeamBudgetSummary, error) {
	return teamPeriodUsage(tx, teamID, 0, now)
}

// Funding admission must always name the actor whose allowance is being checked.
func teamMemberBudgetSummary(tx *gorm.DB, teamID, userID int, now int64) (*TeamBudgetSummary, error) {
	if userID <= 0 {
		return nil, ErrTeamInput
	}
	return teamPeriodUsage(tx, teamID, userID, now)
}

func teamPeriodUsage(tx *gorm.DB, teamID, userID int, now int64) (*TeamBudgetSummary, error) {
	day, week := teamPeriodStarts(now)
	result := &TeamBudgetSummary{DayStart: day, WeekStart: week}
	for _, period := range []struct {
		column         string
		start          int64
		used, reserved *int64
	}{
		{"day_start", day, &result.DailyUsed, &result.DailyReserved},
		{"week_start", week, &result.WeeklyUsed, &result.WeeklyReserved},
	} {
		var totals struct {
			Used     int64
			Reserved int64
		}
		query := tx.Model(&TeamFundingReservation{}).Where("team_id = ? AND "+period.column+" = ?", teamID, period.start)
		if userID > 0 {
			query = query.Where("user_id = ?", userID)
		}
		err := query.Select("COALESCE(SUM(CASE WHEN state = 'settled' THEN actual ELSE 0 END), 0) AS used, COALESCE(SUM(CASE WHEN state = 'reserved' THEN reserved ELSE 0 END), 0) AS reserved").Scan(&totals).Error
		if err != nil {
			return nil, err
		}
		*period.used, *period.reserved = totals.Used, totals.Reserved
	}
	return result, nil
}

func GetTeamBudgetSummary(teamID int, now int64) (*TeamBudgetSummary, error) {
	return teamBudgetSummary(DB, teamID, now)
}

func ReserveTeamFunding(requestID string, teamID, userID, tokenID int, amount int64, modelName string, now int64, bounded ...bool) (*TeamFundingReservation, error) {
	return reserveTeamFunding(requestID, teamID, userID, tokenID, amount, modelName, now, false, bounded...)
}

// ReservePostpaidTeamFunding admits a request against current settled funds.
// Its zero hold preserves source/period snapshots without estimating opaque input.
// In-flight requests may overshoot; subsequent admissions check the actual debt.
func ReservePostpaidTeamFunding(requestID string, teamID, userID, tokenID int, modelName string, now int64) (*TeamFundingReservation, error) {
	return reserveTeamFunding(requestID, teamID, userID, tokenID, 0, modelName, now, true)
}

func reserveTeamFunding(requestID string, teamID, userID, tokenID int, amount int64, modelName string, now int64, postpaid bool, bounded ...bool) (*TeamFundingReservation, error) {
	if requestID == "" || len(requestID) > 128 || teamID <= 0 || userID <= 0 || amount < 0 || amount > int64(common.MaxWalletQuota) {
		return nil, ErrTeamFundingState
	}
	var record TeamFundingReservation
	err := DB.Transaction(func(tx *gorm.DB) error {
		var team Team
		if err := lockForUpdate(tx).First(&team, teamID).Error; err != nil {
			return err
		}
		var user User
		if err := tx.First(&user, userID).Error; err != nil {
			return err
		}
		if team.Status != 1 || user.Status != common.UserStatusEnabled {
			return ErrTeamFundingForbidden
		}
		if !postpaid && len(bounded) > 0 && !bounded[0] && (team.DailyLimit != nil || team.WeeklyLimit != nil) {
			return ErrTeamFundingState
		}
		if user.Role < common.RoleAdminUser {
			var count int64
			if err := tx.Model(&TeamMember{}).Where("team_id = ? AND user_id = ? AND status = 1", teamID, userID).Count(&count).Error; err != nil {
				return err
			}
			if count != 1 {
				return ErrTeamFundingForbidden
			}
		}
		err := tx.First(&record, "request_id = ?", requestID).Error
		if err == nil {
			if record.TeamID != teamID || record.UserID != userID || record.TokenID != tokenID || record.State != "reserved" || record.Reserved != amount || record.Postpaid != postpaid || record.ModelName != modelName {
				return ErrTeamFundingState
			}
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if !postpaid {
			var overruns int64
			if err := tx.Model(&TeamFundingReservation{}).Where("team_id = ? AND user_id = ? AND overrun = ? AND state = ?", teamID, userID, true, "settled").Count(&overruns).Error; err != nil {
				return err
			}
			if overruns > 0 {
				return ErrTeamFundingState
			}
		}
		budget, err := teamMemberBudgetSummary(tx, teamID, userID, now)
		if err != nil {
			return err
		}
		if team.DailyLimit != nil && (postpaid && budget.DailyUsed+budget.DailyReserved >= *team.DailyLimit || budget.DailyUsed > *team.DailyLimit || budget.DailyReserved > *team.DailyLimit-budget.DailyUsed || amount > *team.DailyLimit-budget.DailyUsed-budget.DailyReserved) {
			return ErrTeamDailyLimit
		}
		if team.WeeklyLimit != nil && (postpaid && budget.WeeklyUsed+budget.WeeklyReserved >= *team.WeeklyLimit || budget.WeeklyUsed > *team.WeeklyLimit || budget.WeeklyReserved > *team.WeeklyLimit-budget.WeeklyUsed || amount > *team.WeeklyLimit-budget.WeeklyUsed-budget.WeeklyReserved) {
			return ErrTeamWeeklyLimit
		}
		if team.Balance < amount || postpaid && team.Balance <= 0 {
			return ErrTeamBalance
		}
		if err := tx.Model(&team).Update("balance", team.Balance-amount).Error; err != nil {
			return err
		}
		record = TeamFundingReservation{RequestID: requestID, TeamID: teamID, UserID: userID, TokenID: tokenID, Source: "team", ModelName: modelName, Reserved: amount, State: "reserved", CreatedAt: now, DayStart: budget.DayStart, WeekStart: budget.WeekStart, HardLimited: !postpaid && (team.DailyLimit != nil || team.WeeklyLimit != nil), Postpaid: postpaid, Refundable: true}
		return tx.Create(&record).Error
	})
	return &record, err
}

// SettleTeamFunding sets an absolute final charge, making repeated delivery safe.
// Actual charges remain on the admitted source, including authorized postpaid debt.
func SettleTeamFunding(requestID string, actual int64) error {
	if actual < 0 || actual > int64(common.MaxWalletQuota) {
		return ErrTeamFundingState
	}
	return changeTeamFunding(requestID, "settled", actual)
}

func RefundTeamFunding(requestID string) error { return changeTeamFunding(requestID, "refunded", 0) }

func changeTeamFunding(requestID, state string, actual int64) error {
	var snapshot TeamFundingReservation
	if err := DB.First(&snapshot, "request_id = ?", requestID).Error; err != nil {
		return err
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var team Team
		if err := lockForUpdate(tx).First(&team, snapshot.TeamID).Error; err != nil {
			return err
		}
		var current TeamFundingReservation
		if err := lockForUpdate(tx).First(&current, "request_id = ?", requestID).Error; err != nil {
			return err
		}
		if current.State == "refunded" {
			if state == "refunded" {
				return nil
			}
			return ErrTeamFundingState
		}
		if current.State == "settled" && !current.Refundable && state == "refunded" {
			return ErrTeamFundingState
		}
		before := current.Actual
		if current.State == "reserved" {
			before = current.Reserved
		}
		balance := team.Balance + before - actual
		if balance > int64(common.MaxWalletQuota) || balance < -int64(common.MaxWalletQuota) {
			return ErrTeamFundingState
		}
		if err := tx.Model(&team).Update("balance", balance).Error; err != nil {
			return err
		}
		return tx.Model(&current).Updates(map[string]any{"actual": actual, "state": state, "overrun": current.HardLimited && actual > current.Reserved}).Error
	})
}

// ResizeTeamFunding changes an in-flight reservation on the same source and periods.
func ResizeTeamFunding(requestID string, target int64, bounded ...bool) error {
	if target < 0 || target > int64(common.MaxWalletQuota) {
		return ErrTeamFundingState
	}
	var snapshot TeamFundingReservation
	if err := DB.First(&snapshot, "request_id = ?", requestID).Error; err != nil {
		return err
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var team Team
		if err := lockForUpdate(tx).First(&team, snapshot.TeamID).Error; err != nil {
			return err
		}
		var current TeamFundingReservation
		if err := lockForUpdate(tx).First(&current, "request_id = ?", requestID).Error; err != nil {
			return err
		}
		if current.State != "reserved" || current.Postpaid && target != 0 {
			return ErrTeamFundingState
		}
		delta := target - current.Reserved
		if delta > 0 {
			if len(bounded) > 0 && !bounded[0] && (team.DailyLimit != nil || team.WeeklyLimit != nil) {
				return ErrTeamFundingState
			}
			budget, err := teamMemberBudgetSummary(tx, team.ID, current.UserID, current.CreatedAt)
			if err != nil {
				return err
			}
			if team.Status != 1 {
				return ErrTeamFundingForbidden
			}
			var actor User
			if err := tx.First(&actor, current.UserID).Error; err != nil {
				return err
			}
			if actor.Status != common.UserStatusEnabled {
				return ErrTeamFundingForbidden
			}
			if actor.Role < common.RoleAdminUser {
				var count int64
				if err := tx.Model(&TeamMember{}).Where("team_id = ? AND user_id = ? AND status = 1", team.ID, current.UserID).Count(&count).Error; err != nil {
					return err
				}
				if count != 1 {
					return ErrTeamFundingForbidden
				}
			}
			if team.DailyLimit != nil && delta > *team.DailyLimit-budget.DailyUsed-budget.DailyReserved {
				return ErrTeamDailyLimit
			}
			if team.WeeklyLimit != nil && delta > *team.WeeklyLimit-budget.WeeklyUsed-budget.WeeklyReserved {
				return ErrTeamWeeklyLimit
			}
			if team.Balance < delta {
				return ErrTeamBalance
			}
		}
		balance := team.Balance - delta
		if balance > int64(common.MaxWalletQuota) {
			return ErrTeamFundingState
		}
		if err := tx.Model(&team).Update("balance", balance).Error; err != nil {
			return err
		}
		return tx.Model(&current).Update("reserved", target).Error
	})
}

// TeamUsageRow enriches the ledger without exposing authentication material.
type TeamUsageRow struct {
	TeamFundingReservation
	Username  string `json:"username"`
	TokenName string `json:"token_name"`
}

func TeamUsageQuery(teamID, actorID, globalRole int, search string) (*gorm.DB, error) {
	_, role, err := GetTeam(teamID, actorID, globalRole)
	if err != nil {
		return nil, err
	}
	q := DB.Model(&TeamFundingReservation{}).Where("team_funding_reservations.team_id = ?", teamID)
	if role == "member" {
		q = q.Where("team_funding_reservations.user_id = ?", actorID)
	}
	return filterTeamUsage(q, search, false), nil
}

func filterTeamUsage(q *gorm.DB, search string, names bool) *gorm.DB {
	if search = strings.TrimSpace(search); search != "" {
		pattern := "%" + search + "%"
		filter := DB.Where("team_funding_reservations.model_name LIKE ? OR team_funding_reservations.request_id LIKE ? OR team_funding_reservations.state LIKE ?", pattern, pattern, pattern)
		if id, err := strconv.Atoi(search); err == nil {
			filter = filter.Or("team_funding_reservations.user_id = ? OR team_funding_reservations.token_id = ?", id, id)
		}
		if names {
			filter = filter.Or("users.username LIKE ? OR tokens.name LIKE ?", pattern, pattern)
		}
		q = q.Where(filter)
	}
	return q
}

func TeamUsageDisplayQuery(teamID, actorID, globalRole int, search string) (*gorm.DB, error) {
	q, err := TeamUsageQuery(teamID, actorID, globalRole, "")
	if err != nil {
		return nil, err
	}
	// Match key ownership as well as ID; removed memberships retain their history.
	q = q.Joins("LEFT JOIN users ON users.id = team_funding_reservations.user_id").
		Joins("LEFT JOIN tokens ON tokens.id = team_funding_reservations.token_id AND tokens.user_id = team_funding_reservations.user_id").
		Select("team_funding_reservations.*, COALESCE(users.username, '') AS username, COALESCE(tokens.name, '') AS token_name")
	return filterTeamUsage(q, search, true), nil
}

func ListTeamUsage(teamID, actorID, globalRole int) ([]TeamUsageRow, error) {
	q, err := TeamUsageDisplayQuery(teamID, actorID, globalRole, "")
	if err != nil {
		return nil, err
	}
	rows := make([]TeamUsageRow, 0)
	err = q.Order("team_funding_reservations.created_at DESC, team_funding_reservations.request_id DESC").Limit(500).Find(&rows).Error
	return rows, err
}

func RecordTeamFundingUsage(requestID string, prompt, completion int) error {
	return DB.Model(&TeamFundingReservation{}).Where("request_id = ?", requestID).Updates(map[string]any{"prompt_tokens": prompt, "completion_tokens": completion}).Error
}

func GetTeamRefundLiability(tx *gorm.DB, teamID int) (int64, error) {
	var total int64
	err := tx.Model(&TeamFundingReservation{}).Where("team_id = ?", teamID).Select("COALESCE(SUM(CASE WHEN state = 'reserved' THEN reserved WHEN state = 'settled' AND refundable = ? THEN actual ELSE 0 END), 0)", true).Scan(&total).Error
	return total, err
}

func CloseTeamFundingRefundWindow(requestID string) error {
	return DB.Model(&TeamFundingReservation{}).Where("request_id = ? AND state = ?", requestID, "settled").Update("refundable", false).Error
}

// RecordTeamFundingRoute snapshots the actual route, independent of later channel renames.
func RecordTeamFundingRoute(requestID, group string, channelID int, channelName string) error {
	return DB.Model(&TeamFundingReservation{}).Where("request_id = ?", requestID).Updates(map[string]any{"using_group": group, "channel_id": channelID, "channel_name": channelName}).Error
}
