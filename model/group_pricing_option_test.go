package model

import (
	"errors"
	"maps"
	"os"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func useGroupPricingTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	if os.Getenv("TEAM_TEST_DIALECT") == "mysql" || os.Getenv("TEAM_TEST_DIALECT") == "postgres" {
		setupTeamTest(t)
		require.NoError(t, DB.AutoMigrate(&Option{}))
		for _, key := range []string{"GroupRatio", "GroupGroupRatio", "group_ratio_setting.group_ratio", "group_ratio_setting.group_group_ratio", "SystemName"} {
			require.NoError(t, DB.Where(&Option{Key: key}).Delete(&Option{}).Error)
		}
		return DB
	}
	db := useFrontendOptionMigrationDB(t)
	connection, err := db.DB()
	require.NoError(t, err)
	connection.SetMaxOpenConns(1)
	return db
}

func TestGroupPricingAliasesWriteAndReloadOneValue(t *testing.T) {
	db := useGroupPricingTestDB(t)
	originalOptions := maps.Clone(common.OptionMap)
	common.OptionMap = make(map[string]string)
	originalGroups := ratio_setting.GroupRatio2JSONString()
	originalOverrides := ratio_setting.GroupGroupRatio2JSONString()
	t.Cleanup(func() {
		common.OptionMap = originalOptions
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(originalGroups))
		require.NoError(t, ratio_setting.UpdateGroupGroupRatioByJSONString(originalOverrides))
	})
	for _, pair := range [][2]string{{"GroupRatio", "group_ratio_setting.group_ratio"}, {"GroupGroupRatio", "group_ratio_setting.group_group_ratio"}} {
		for i, key := range pair {
			value := `{"development":1,"testing":1.5}`
			if pair[0] == "GroupGroupRatio" {
				value = `{"staff":{"testing":0.8}}`
			}
			if i == 1 {
				value = `{}`
			}
			require.NoError(t, UpdateOption(key, value))
			for _, alias := range pair {
				require.JSONEq(t, value, requireOptionValue(t, db, alias))
				require.JSONEq(t, value, common.Interface2String(common.OptionMap[alias]))
			}
			loadOptionsFromDatabase()
			loadOptionsFromDatabase()
			for _, alias := range pair {
				require.JSONEq(t, value, common.Interface2String(common.OptionMap[alias]))
			}
		}
	}
	require.Empty(t, ratio_setting.GetGroupRatioCopy(), "an explicit empty map must not resurrect old names")
}

func TestGroupPricingLegacyConflictHasDeterministicConsolePriority(t *testing.T) {
	db := useGroupPricingTestDB(t)
	originalOptions := maps.Clone(common.OptionMap)
	common.OptionMap = make(map[string]string)
	originalGroups := ratio_setting.GroupRatio2JSONString()
	t.Cleanup(func() {
		common.OptionMap = originalOptions
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(originalGroups))
	})
	require.NoError(t, db.Create(&Option{Key: "GroupRatio", Value: `{"current-team":1.5}`}).Error)
	require.NoError(t, db.Create(&Option{Key: "group_ratio_setting.group_ratio", Value: `{"obsolete-team":1}`}).Error)
	for range 3 {
		loadOptionsFromDatabase()
		require.Equal(t, map[string]float64{"current-team": 1.5}, ratio_setting.GetGroupRatioCopy())
		require.JSONEq(t, `{"current-team":1.5}`, common.Interface2String(common.OptionMap["group_ratio_setting.group_ratio"]))
	}
	// A typed-only install still populates the console's compatibility field.
	require.NoError(t, db.Where(&Option{Key: "GroupRatio"}).Delete(&Option{}).Error)
	loadOptionsFromDatabase()
	require.JSONEq(t, `{"obsolete-team":1}`, common.Interface2String(common.OptionMap["GroupRatio"]))
}

func TestGroupPricingInvalidAndConflictingWritesAreAtomic(t *testing.T) {
	db := useGroupPricingTestDB(t)
	originalOptions := maps.Clone(common.OptionMap)
	common.OptionMap = make(map[string]string)
	originalGroups := ratio_setting.GroupRatio2JSONString()
	t.Cleanup(func() {
		common.OptionMap = originalOptions
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(originalGroups))
	})
	require.NoError(t, UpdateOption("GroupRatio", `{"kept":1.5}`))
	for _, bad := range []string{`null`, `[]`, `{"kept":-1}`, `{"kept":"free"}`, `{`} {
		require.Error(t, UpdateOption("group_ratio_setting.group_ratio", bad))
		require.JSONEq(t, `{"kept":1.5}`, requireOptionValue(t, db, "GroupRatio"))
		require.Equal(t, map[string]float64{"kept": 1.5}, ratio_setting.GetGroupRatioCopy())
	}
	require.Error(t, UpdateOptionsBulk(map[string]string{"GroupRatio": `{"a":1}`, "group_ratio_setting.group_ratio": `{"b":2}`, "SystemName": "must-not-write"}))
	requireOptionMissing(t, db, "SystemName")
	require.JSONEq(t, `{"kept":1.5}`, requireOptionValue(t, db, "group_ratio_setting.group_ratio"))
	// A failure on the second row must roll back the first and never publish it.
	callback := "test:group-pricing-write-failure"
	require.NoError(t, db.Callback().Update().Before("gorm:update").Register(callback, func(tx *gorm.DB) {
		if option, ok := tx.Statement.Dest.(*Option); ok && option.Key == "group_ratio_setting.group_ratio" {
			tx.AddError(errors.New("isolated write failure"))
		}
	}))
	require.Error(t, UpdateOption("GroupRatio", `{"changed":2}`))
	require.NoError(t, db.Callback().Update().Remove(callback))
	require.JSONEq(t, `{"kept":1.5}`, requireOptionValue(t, db, "GroupRatio"))
	require.Equal(t, map[string]float64{"kept": 1.5}, ratio_setting.GetGroupRatioCopy())
}

func TestGroupPricingConcurrentAliasesAndReloadStayConsistent(t *testing.T) {
	db := useGroupPricingTestDB(t)
	originalOptions := maps.Clone(common.OptionMap)
	common.OptionMap = make(map[string]string)
	originalGroups := ratio_setting.GroupRatio2JSONString()
	t.Cleanup(func() {
		common.OptionMap = originalOptions
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(originalGroups))
	})
	require.NoError(t, UpdateOption("GroupRatio", `{"first":1}`))
	errors := make(chan error, 12)
	var wg sync.WaitGroup
	for i := range 12 {
		wg.Go(func() {
			if i%3 == 0 {
				loadOptionsFromDatabase()
				return
			}
			key := "GroupRatio"
			if i%2 == 0 {
				key = "group_ratio_setting.group_ratio"
			}
			errors <- UpdateOption(key, `{"new":1.5}`)
		})
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		require.NoError(t, err)
	}
	loadOptionsFromDatabase()
	require.JSONEq(t, `{"new":1.5}`, requireOptionValue(t, db, "GroupRatio"))
	require.JSONEq(t, common.OptionMap["GroupRatio"], common.OptionMap["group_ratio_setting.group_ratio"])
	require.Equal(t, map[string]float64{"new": 1.5}, ratio_setting.GetGroupRatioCopy())
}
