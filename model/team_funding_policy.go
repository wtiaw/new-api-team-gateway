package model

import (
	"errors"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type TeamKeyPolicy struct {
	TokenID   int    `json:"token_id" gorm:"primaryKey;autoIncrement:false"`
	UserID    int    `json:"user_id" gorm:"index"`
	TeamID    int    `json:"team_id" gorm:"index"`
	Mode      string `json:"mode" gorm:"type:varchar(32)"`
	IsDefault bool   `json:"is_default" gorm:"-"`
}

// DefaultTeamKeyPolicy follows an actual active membership, never the list of
// teams a system administrator is merely allowed to manage.
func DefaultTeamKeyPolicy(userID int) (*TeamKeyPolicy, error) {
	policy := &TeamKeyPolicy{UserID: userID, Mode: "legacy", IsDefault: true}
	var teams []Team
	err := DB.Model(&Team{}).
		Joins("JOIN team_members ON team_members.team_id = teams.id").
		Where("team_members.user_id = ? AND team_members.status = ? AND teams.status = ?", userID, 1, 1).
		Limit(2).Find(&teams).Error
	if err != nil {
		return nil, err
	}
	if len(teams) == 1 {
		policy.TeamID, policy.Mode = teams[0].ID, "team_first"
		if !teams[0].AllowPersonalBackup {
			policy.Mode = "team_only"
		}
	}
	return policy, nil
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
	if len(result) == len(tokens) {
		return result, nil
	}
	defaultPolicy, err := DefaultTeamKeyPolicy(userID)
	if err != nil {
		return nil, err
	}
	for _, token := range tokens {
		if result[token.Id] == nil {
			policy := *defaultPolicy
			policy.TokenID = token.Id
			result[token.Id] = &policy
		}
	}
	return result, nil
}

func GetTeamKeyPolicy(tokenID, userID int) (*TeamKeyPolicy, error) {
	var token Token
	if err := DB.Where("id = ? AND user_id = ?", tokenID, userID).First(&token).Error; err != nil {
		return nil, err
	}
	var policy TeamKeyPolicy
	err := DB.First(&policy, "token_id = ? AND user_id = ?", tokenID, userID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		defaultPolicy, defaultErr := DefaultTeamKeyPolicy(userID)
		if defaultErr != nil {
			return nil, defaultErr
		}
		defaultPolicy.TokenID = tokenID
		return defaultPolicy, nil
	}
	return &policy, err
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
	case "personal_only":
		policy.TeamID = 0
	case "team_only", "team_first", "personal_first":
		var user User
		if err := DB.First(&user, userID).Error; err != nil {
			return err
		}
		if err := RequireTeamAccess(policy.TeamID, userID, user.Role, false); err != nil {
			return err
		}
		var team Team
		if err := DB.First(&team, policy.TeamID).Error; err != nil {
			return err
		}
		if (policy.Mode == "team_first" || policy.Mode == "personal_first") && !team.AllowPersonalBackup {
			return ErrTeamPersonalBackupDisabled
		}
	default:
		return ErrTeamFundingState
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
