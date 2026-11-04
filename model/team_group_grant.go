package model

import (
	"crypto/sha256"
	"encoding/hex"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// TeamGroupGrant enforces one owner for an exact resource group name. A hash
// primary key keeps case-sensitive name identity consistent across SQL collations.
// AllowedGroups remains the compatible authorization snapshot on Team.
type TeamGroupGrant struct {
	GroupHash string `gorm:"type:varchar(64);primaryKey"`
	GroupName string `gorm:"type:text;not null"`
	TeamID    int    `gorm:"not null;index"`
}

func teamGroupHash(name string) string {
	digest := sha256.Sum256([]byte(name))
	return hex.EncodeToString(digest[:])
}

// syncTeamGroupGrants runs in the same transaction as the team mutation.
// The unique key arbitrates simultaneous claims from different app instances.
func syncTeamGroupGrants(tx *gorm.DB, teamID int, groups []string) error {
	if err := tx.Where("team_id = ?", teamID).Delete(&TeamGroupGrant{}).Error; err != nil {
		return err
	}
	for _, group := range groups {
		claim := TeamGroupGrant{GroupHash: teamGroupHash(group), GroupName: group, TeamID: teamID}
		if err := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "group_hash"}}, DoNothing: true}).Create(&claim).Error; err != nil {
			return err
		}
		var owner TeamGroupGrant
		if err := lockForUpdate(tx).Where("group_hash = ?", claim.GroupHash).First(&owner).Error; err != nil {
			return err
		}
		if owner.TeamID != teamID || owner.GroupName != group {
			return ErrTeamGroupConflict
		}
	}
	return nil
}

// migrateTeamGroupGrants rebuilds the derived ownership guard from persisted
// grants, including disabled teams. Conflicting legacy grants fail atomically.
func migrateTeamGroupGrants(db *gorm.DB) error {
	return db.Transaction(func(tx *gorm.DB) error {
		var teams []Team
		if err := lockForUpdate(tx).Select("id", "allowed_groups").Order("id").Find(&teams).Error; err != nil {
			return err
		}
		if err := tx.Where("team_id NOT IN (?)", tx.Model(&Team{}).Select("id")).Delete(&TeamGroupGrant{}).Error; err != nil {
			return err
		}
		ids := make([]int, 0, len(teams))
		for _, team := range teams {
			ids = append(ids, team.ID)
		}
		if len(ids) > 0 {
			if err := tx.Where("team_id IN ?", ids).Delete(&TeamGroupGrant{}).Error; err != nil {
				return err
			}
		}
		for _, team := range teams {
			if err := syncTeamGroupGrants(tx, team.ID, team.AllowedGroups); err != nil {
				return err
			}
		}
		return nil
	})
}
