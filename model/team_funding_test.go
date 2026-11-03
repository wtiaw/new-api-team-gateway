package model

import (
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestTeamOverviewAggregatesCompleteHistoryAndRespectsScope(t *testing.T) {
	sys, admin, member, team := setupTeamTest(t)
	now := time.Date(2026, 11, 2, 0, 5, 0, 0, time.FixedZone("CST", 8*3600)).Unix()
	day, week := teamPeriodStarts(now)
	_, err := GetTeamOverview(team.ID, member.Id, 1, 7, now)
	require.ErrorIs(t, err, ErrTeamAccess)
	require.NoError(t, DB.Create(&TeamMember{TeamID: team.ID, UserID: member.Id, Role: "member", Status: 1}).Error)
	rows := make([]TeamFundingReservation, 0, 507)
	// More than one usage page: overview totals must never use the legacy 500-row list.
	for i := range 501 {
		rows = append(rows, TeamFundingReservation{RequestID: fmt.Sprintf("overview-%d-%d", team.ID, i), TeamID: team.ID, UserID: member.Id, ModelName: "gpt-test", State: "settled", Actual: 14, Reserved: 100, PromptTokens: 12, CompletionTokens: 8, CreatedAt: day - 1, DayStart: day - 86400, WeekStart: week - 7*86400})
	}
	for _, fixture := range []struct {
		name, state, model   string
		userID               int
		at, actual, reserved int64
	}{
		{"manager", "settled", "deepseek-test", admin.Id, now, 40, 50},
		{"pending", "reserved", "gpt-test", member.Id, now, 99, 23},
		{"refunded", "refunded", "gpt-test", member.Id, now, 99, 90},
		{"older", "settled", "deepseek-test", member.Id, day - 8*86400, 11, 0},
		{"expired", "settled", "hidden", member.Id, day - 31*86400, 999, 0},
		{"future", "settled", "hidden", member.Id, now + 1, 999, 0},
	} {
		d, w := teamPeriodStarts(fixture.at)
		rows = append(rows, TeamFundingReservation{RequestID: fmt.Sprintf("overview-%d-%s", team.ID, fixture.name), TeamID: team.ID, UserID: fixture.userID, ModelName: fixture.model, State: fixture.state, Actual: fixture.actual, Reserved: fixture.reserved, PromptTokens: 2, CompletionTokens: 3, CreatedAt: fixture.at, DayStart: d, WeekStart: w})
	}
	require.NoError(t, DB.CreateInBatches(&rows, 100).Error)
	other, err := CreateTeam(sys.Id, 10, TeamCreate{Name: "Other overview team", AdminUserID: sys.Id})
	require.NoError(t, err)
	require.NoError(t, DB.Create(&TeamFundingReservation{RequestID: fmt.Sprintf("overview-other-%d", other.ID), TeamID: other.ID, UserID: member.Id, ModelName: "hidden", State: "settled", Actual: 999, CreatedAt: now, DayStart: day, WeekStart: week}).Error)

	result, err := GetTeamOverview(team.ID, admin.Id, 1, 7, now)
	require.NoError(t, err)
	assert.Equal(t, "team", result.Scope)
	assert.Equal(t, day-6*86400, result.StartTime)
	assert.Equal(t, now, result.EndTime)
	assert.Equal(t, TeamUsageMetrics{Requests: 504, SettledRequests: 502, ReservedRequests: 1, RefundedRequests: 1, Actual: 7054, Reserved: 23, PromptTokens: 6014, CompletionTokens: 4011}, result.Summary)
	require.Len(t, result.Trend, 7)
	assert.Zero(t, result.Trend[0].Requests)
	assert.EqualValues(t, 501, result.Trend[5].Requests)
	assert.Equal(t, day-86400, result.Trend[5].DayStart)
	assert.EqualValues(t, 3, result.Trend[6].Requests)
	require.Len(t, result.Models, 2)
	assert.Equal(t, "gpt-test", result.Models[0].ModelName)
	assert.EqualValues(t, 7014, result.Models[0].Actual)
	assert.Equal(t, "deepseek-test", result.Models[1].ModelName)

	mine, err := GetTeamOverview(team.ID, member.Id, 1, 30, now)
	require.NoError(t, err)
	assert.Equal(t, "mine", mine.Scope)
	assert.EqualValues(t, 504, mine.Summary.Requests)
	assert.EqualValues(t, 7025, mine.Summary.Actual)
	require.Len(t, mine.Trend, 30)
	assert.Equal(t, day-29*86400, mine.Trend[0].DayStart)
	assert.EqualValues(t, 11, mine.Trend[21].Actual)
	// A session's former system role must not widen a persisted member's scope.
	staleRole, err := GetTeamOverview(team.ID, member.Id, 10, 30, now)
	require.NoError(t, err)
	assert.Equal(t, mine.Summary, staleRole.Summary)
	system, err := GetTeamOverview(team.ID, sys.Id, 10, 7, now)
	require.NoError(t, err)
	assert.Equal(t, result.Summary, system.Summary)
	_, err = GetTeamOverview(other.ID, admin.Id, 1, 7, now)
	require.ErrorIs(t, err, ErrTeamAccess)
	for _, days := range []int{0, -1, 8, 31} {
		_, err = GetTeamOverview(team.ID, admin.Id, 1, days, now)
		require.ErrorIs(t, err, ErrTeamInput)
	}
	empty, err := GetTeamOverview(other.ID, sys.Id, 10, 7, now-40*86400)
	require.NoError(t, err)
	assert.Zero(t, empty.Summary)
	assert.Empty(t, empty.Models)
	assert.NotNil(t, empty.Models)
	require.Len(t, empty.Trend, 7)
	require.NoError(t, UpdateTeamMember(team.ID, admin.Id, member.Id, 1, nil, nil, true))
	_, err = GetTeamOverview(team.ID, member.Id, 1, 7, now)
	require.ErrorIs(t, err, ErrTeamAccess)
}

func TestTeamOverviewCalendarSpending(t *testing.T) {
	sys, admin, member, team := setupTeamTest(t)
	require.NoError(t, DB.Create(&TeamMember{TeamID: team.ID, UserID: member.Id, Role: "member", Status: 1}).Error)
	now := time.Date(2026, 11, 4, 0, 5, 0, 0, time.FixedZone("CST", 8*3600)).Unix()
	day, week := teamPeriodStarts(now)
	for i, row := range []TeamFundingReservation{
		{UserID: member.Id, State: "settled", Actual: 13, CreatedAt: now},
		{UserID: member.Id, State: "settled", Actual: 17, CreatedAt: day - 1},
		{UserID: member.Id, State: "settled", Actual: 101, CreatedAt: week - 1},
		{UserID: member.Id, State: "reserved", Actual: 99, Reserved: 5, CreatedAt: now},
		{UserID: member.Id, State: "refunded", Actual: 99, Reserved: 50, CreatedAt: now},
		{UserID: member.Id, State: "settled", Actual: 99, CreatedAt: now + 1},
		{UserID: admin.Id, State: "settled", Actual: 99, CreatedAt: now},
	} {
		row.TeamID = team.ID
		row.RequestID = fmt.Sprintf("calendar-%d-%d", team.ID, i)
		row.DayStart, row.WeekStart = teamPeriodStarts(row.CreatedAt)
		require.NoError(t, DB.Create(&row).Error)
	}
	for _, days := range []int{7, 30} {
		mine, err := GetTeamOverview(team.ID, member.Id, 10, days, now)
		require.NoError(t, err)
		assert.Equal(t, "mine", mine.Scope)
		assert.Equal(t, TeamBudgetSummary{DailyUsed: 13, WeeklyUsed: 30, DailyReserved: 5, WeeklyReserved: 5, DayStart: day, WeekStart: week}, mine.PeriodUsage)
		for _, actor := range []User{sys, admin} {
			overview, err := GetTeamOverview(team.ID, actor.Id, actor.Role, days, now)
			require.NoError(t, err)
			assert.EqualValues(t, 112, overview.PeriodUsage.DailyUsed)
			assert.EqualValues(t, 129, overview.PeriodUsage.WeeklyUsed)
		}
		empty, err := GetTeamOverview(team.ID, member.Id, 1, days, week-8*86400)
		require.NoError(t, err)
		assert.Zero(t, empty.PeriodUsage.DailyUsed)
		assert.Zero(t, empty.PeriodUsage.WeeklyUsed)
	}
}

func TestTeamDefaultKeyFunding(t *testing.T) {
	sys, _, member, team := setupTeamTest(t)
	require.NoError(t, DB.AutoMigrate(&Token{}))
	key := Token{UserId: member.Id, Key: fmt.Sprintf("default-key-%d-%d", team.ID, member.Id), Name: "existing", Status: common.TokenStatusEnabled, UnlimitedQuota: true}
	require.NoError(t, DB.Create(&key).Error)
	policy, err := GetTeamKeyPolicy(key.Id, member.Id)
	require.NoError(t, err)
	assert.Equal(t, "legacy", policy.Mode)
	require.NoError(t, DB.Create(&TeamMember{TeamID: team.ID, UserID: member.Id, Role: "member", Status: 1}).Error)
	policy, err = GetTeamKeyPolicy(key.Id, member.Id)
	require.NoError(t, err)
	assert.Equal(t, "team_first", policy.Mode, "an existing unconfigured key must follow the current team")
	assert.Equal(t, team.ID, policy.TeamID)
	assert.True(t, policy.IsDefault)
	second := Token{UserId: member.Id, Key: fmt.Sprintf("second-key-%d", team.ID), Name: "new", Status: common.TokenStatusEnabled, UnlimitedQuota: true}
	require.NoError(t, DB.Create(&second).Error)
	policies, err := GetTeamKeyPolicies([]*Token{&key, &second}, member.Id)
	require.NoError(t, err)
	require.Len(t, policies, 2)
	assert.Equal(t, "team_first", policies[second.Id].Mode)
	assert.Equal(t, key.Id, policies[key.Id].TokenID)
	assert.Equal(t, second.Id, policies[second.Id].TokenID)
	_, err = GetTeamKeyPolicies([]*Token{&key}, sys.Id)
	require.ErrorIs(t, err, ErrTeamFundingForbidden)
	require.NoError(t, SetTeamKeyPolicy(key.Id, member.Id, TeamKeyPolicy{Mode: "personal_only"}))
	policy, err = GetTeamKeyPolicy(key.Id, member.Id)
	require.NoError(t, err)
	assert.Equal(t, "personal_only", policy.Mode, "an explicit choice must not be overridden")
	assert.False(t, policy.IsDefault)
	defaultSystem, err := DefaultTeamKeyPolicy(sys.Id)
	require.NoError(t, err)
	assert.Equal(t, "legacy", defaultSystem.Mode, "managing a team does not make it a source of personal funding")
	require.NoError(t, SetTeamKeyPolicy(key.Id, member.Id, TeamKeyPolicy{Mode: "legacy"}))
	require.NoError(t, DB.Model(&Team{}).Where("id = ?", team.ID).Update("allow_personal_backup", false).Error)
	policy, err = GetTeamKeyPolicy(key.Id, member.Id)
	require.NoError(t, err)
	assert.Equal(t, "team_only", policy.Mode, "automatic selection must honor the team's backup restriction")
	require.NoError(t, DB.Model(&TeamMember{}).Where("team_id = ? AND user_id = ?", team.ID, member.Id).Update("status", 2).Error)
	policy, err = GetTeamKeyPolicy(key.Id, member.Id)
	require.NoError(t, err)
	assert.Equal(t, "legacy", policy.Mode)
	_, err = GetTeamKeyPolicy(key.Id, sys.Id)
	require.Error(t, err, "another account must not inspect this key")
}

func TestTeamFundingLifecycle(t *testing.T) {
	var dialector gorm.Dialector = sqlite.Open("file:" + t.Name() + "?mode=memory&cache=shared")
	switch os.Getenv("TEAM_TEST_DIALECT") {
	case "mysql":
		dialector = mysql.Open(os.Getenv("TEAM_TEST_DSN"))
	case "postgres":
		dialector = postgres.Open(os.Getenv("TEAM_TEST_DSN"))
	}
	db, err := gorm.Open(dialector, &gorm.Config{})
	require.NoError(t, err)
	if db.Dialector.Name() == "sqlite" {
		var version string
		require.NoError(t, db.Raw("SELECT sqlite_version()").Scan(&version).Error)
		t.Log("SQLite version:", version)
	}
	previous := DB
	previousType := common.MainDatabaseType()
	DB = db
	common.SetMainDatabaseType(common.DatabaseType(db.Dialector.Name()))
	if db.Dialector.Name() == "postgres" {
		common.SetMainDatabaseType(common.DatabaseTypePostgreSQL)
	}
	t.Cleanup(func() { DB = previous; common.SetMainDatabaseType(previousType) })
	require.NoError(t, db.AutoMigrate(&User{}, &Token{}, &Team{}, &TeamMember{}))
	require.NoError(t, MigrateTeamFunding(db))
	// Repeated startup must preserve tables, records and uniqueness constraints.
	require.NoError(t, MigrateTeamFunding(db))
	user := User{Username: "funding-fixture", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Quota: 321}
	require.NoError(t, db.Create(&user).Error)
	team := Team{Name: "Funding fixture", Status: 1, Balance: 100, DailyLimit: new(int64(20)), WeeklyLimit: new(int64(30))}
	require.NoError(t, db.Create(&team).Error)
	require.NoError(t, db.Create(&TeamMember{TeamID: team.ID, UserID: user.Id, Role: "member", Status: 1}).Error)
	now := time.Date(2026, 11, 2, 23, 59, 0, 0, time.FixedZone("CST", 8*3600)).Unix()
	r, err := ReserveTeamFunding("fixture-first", team.ID, user.Id, 7, 15, "fixture-model", now)
	require.NoError(t, err)
	assert.Equal(t, int64(15), r.Reserved)
	_, err = ReserveTeamFunding("fixture-other", team.ID, user.Id, 8, 6, "fixture-model", now)
	require.ErrorIs(t, err, ErrTeamDailyLimit)
	// The same operation is idempotent; a different actor cannot reuse it.
	_, err = ReserveTeamFunding("fixture-first", team.ID, user.Id, 7, 15, "fixture-model", now)
	require.NoError(t, err)
	_, err = ReserveTeamFunding("fixture-first", team.ID, user.Id+1, 7, 15, "fixture-model", now)
	require.Error(t, err)
	require.NoError(t, SettleTeamFunding("fixture-first", 10))
	require.NoError(t, SettleTeamFunding("fixture-first", 10))
	_, err = ReserveTeamFunding("fixture-next", team.ID, user.Id, 8, 10, "fixture-model", now)
	require.NoError(t, err)
	require.NoError(t, RefundTeamFunding("fixture-next"))
	require.NoError(t, RefundTeamFunding("fixture-next"))
	budget, err := GetTeamBudgetSummary(team.ID, now)
	require.NoError(t, err)
	assert.Equal(t, int64(10), budget.DailyUsed)
	assert.Zero(t, budget.DailyReserved)
	// Cross-midnight refunds change the original period, not today's new bucket.
	_, err = ReserveTeamFunding("fixture-tomorrow", team.ID, user.Id, 9, 20, "fixture-model", now+120)
	require.NoError(t, err)
	require.NoError(t, SettleTeamFunding("fixture-tomorrow", 20))
	_, err = ReserveTeamFunding("fixture-week-exhausted", team.ID, user.Id, 10, 1, "fixture-model", now+2*86400)
	require.ErrorIs(t, err, ErrTeamWeeklyLimit)
	require.NoError(t, RefundTeamFunding("fixture-first"))
	budget, err = GetTeamBudgetSummary(team.ID, now)
	require.NoError(t, err)
	assert.Zero(t, budget.DailyUsed)
	require.NoError(t, db.First(&team, team.ID).Error)
	assert.Equal(t, int64(80), team.Balance)
	require.NoError(t, db.First(&user, user.Id).Error)
	assert.Equal(t, 321, user.Quota, "team accounting must never modify personal balance")
	_, err = ReserveTeamFunding("negative", team.ID, user.Id, 7, -1, "fixture-model", now)
	require.Error(t, err)
	_, err = ReserveTeamFunding("overflow", team.ID, user.Id, 7, int64(common.MaxWalletQuota)+1, "fixture-model", now)
	require.Error(t, err)
	require.NoError(t, db.Model(&team).Updates(map[string]any{"daily_limit": nil, "weekly_limit": nil}).Error)
	_, err = ReserveTeamFunding("native-estimate", team.ID, user.Id, 7, 5, "fixture-model", now)
	require.NoError(t, err)
	require.NoError(t, SettleTeamFunding("native-estimate", 10))
	var estimated TeamFundingReservation
	require.NoError(t, db.First(&estimated, "request_id = ?", "native-estimate").Error)
	assert.False(t, estimated.Overrun, "ordinary estimates on unlimited teams must not freeze the wallet")
	_, err = ReserveTeamFunding("after-native-estimate", team.ID, user.Id, 8, 1, "fixture-model", now)
	require.NoError(t, err)
	require.NoError(t, RefundTeamFunding("after-native-estimate"))
}

func TestTeamPostpaidSettlementAllowsDebtAndStopsFollowingRequests(t *testing.T) {
	_, admin, member, team := setupTeamTest(t)
	require.NoError(t, DB.Create(&TeamMember{TeamID: team.ID, UserID: member.Id, Role: "member", Status: 1}).Error)
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.FixedZone("CST", 8*3600)).Unix()
	require.NoError(t, DB.Model(&Team{}).Where("id = ?", team.ID).Updates(map[string]any{"balance": 5, "daily_limit": 5, "weekly_limit": 5}).Error)
	id := fmt.Sprintf("postpaid-%d", team.ID)
	row, err := ReservePostpaidTeamFunding(id, team.ID, member.Id, 0, "codex", now)
	require.NoError(t, err)
	require.Zero(t, row.Reserved)
	require.True(t, row.Postpaid)
	_, err = ReservePostpaidTeamFunding(id, team.ID, member.Id, 0, "codex", now)
	require.NoError(t, err)
	require.NoError(t, SettleTeamFunding(id, 14))
	require.NoError(t, SettleTeamFunding(id, 14))
	require.NoError(t, DB.First(&team, team.ID).Error)
	require.EqualValues(t, -9, team.Balance)
	budget, err := GetTeamBudgetSummary(team.ID, now)
	require.NoError(t, err)
	require.EqualValues(t, 14, budget.DailyUsed)
	require.EqualValues(t, 14, budget.WeeklyUsed)
	_, err = ReservePostpaidTeamFunding(id+"-blocked", team.ID, member.Id, 0, "codex", now)
	require.ErrorIs(t, err, ErrTeamDailyLimit)
	require.NoError(t, DB.Model(&team).Updates(map[string]any{"daily_limit": nil, "weekly_limit": nil}).Error)
	_, err = ReservePostpaidTeamFunding(id+"-debt", team.ID, member.Id, 0, "codex", now)
	require.ErrorIs(t, err, ErrTeamBalance)
	require.NoError(t, DB.Model(&team).Updates(map[string]any{"balance": 5, "daily_limit": 5, "weekly_limit": 5}).Error)
	_, err = ReservePostpaidTeamFunding(id+"-tomorrow", team.ID, member.Id, 0, "codex", now+86400)
	require.ErrorIs(t, err, ErrTeamWeeklyLimit)
	retry, err := ReservePostpaidTeamFunding(id+"-next-week", team.ID, member.Id, 0, "codex", now+7*86400)
	require.NoError(t, err)
	require.NoError(t, RefundTeamFunding(retry.RequestID))
	require.NoError(t, RefundTeamFunding(retry.RequestID))
	require.NoError(t, DB.First(&team, team.ID).Error)
	require.EqualValues(t, 5, team.Balance)
	_, err = ReservePostpaidTeamFunding(id+"-unauthorized", team.ID, admin.Id+1000000, 0, "codex", now)
	require.Error(t, err)
}

func TestTeamUsageNamesPreserveHistoryAndPrivacy(t *testing.T) {
	_, admin, member, team := setupTeamTest(t)
	require.NoError(t, DB.AutoMigrate(&Token{}))
	require.NoError(t, DB.Create(&TeamMember{TeamID: team.ID, UserID: member.Id, Role: "member", Status: 1}).Error)
	key := Token{UserId: member.Id, Name: "Codex workstation", Key: common.GetRandomString(48)}
	foreign := Token{UserId: admin.Id, Name: "Private manager key", Key: common.GetRandomString(48)}
	require.NoError(t, DB.Create(&key).Error)
	require.NoError(t, DB.Create(&foreign).Error)
	for i, tokenID := range []int{key.Id, foreign.Id, 0} {
		require.NoError(t, DB.Create(&TeamFundingReservation{RequestID: fmt.Sprintf("names-%d-%d", team.ID, i), TeamID: team.ID, UserID: member.Id, TokenID: tokenID, State: "settled"}).Error)
	}
	require.NoError(t, DB.Create(&TeamFundingReservation{RequestID: fmt.Sprintf("names-manager-%d", team.ID), TeamID: team.ID, UserID: admin.Id, TokenID: foreign.Id, State: "settled"}).Error)
	q, err := TeamUsageDisplayQuery(team.ID, member.Id, 1, "Codex workstation")
	require.NoError(t, err)
	var rows []TeamUsageRow
	require.NoError(t, q.Find(&rows).Error)
	require.Len(t, rows, 1)
	require.Equal(t, member.Username, rows[0].Username)
	require.Equal(t, key.Name, rows[0].TokenName)
	q, err = TeamUsageDisplayQuery(team.ID, member.Id, 10, "Private manager key")
	require.NoError(t, err)
	require.NoError(t, q.Find(&rows).Error)
	require.Empty(t, rows)
	require.NoError(t, UpdateTeamMember(team.ID, admin.Id, member.Id, 1, nil, nil, true))
	rows, err = ListTeamUsage(team.ID, admin.Id, 1)
	require.NoError(t, err)
	require.Len(t, rows, 4)
	found := false
	for _, row := range rows {
		if row.TokenID == key.Id {
			require.Equal(t, member.Username, row.Username)
			found = true
		}
	}
	require.True(t, found)
}

func TestTeamOverviewFiltersMemberIncludingRemovedHistory(t *testing.T) {
	sys, admin, member, team := setupTeamTest(t)
	require.NoError(t, DB.Create(&TeamMember{TeamID: team.ID, UserID: member.Id, Role: "member", Status: 1}).Error)
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.FixedZone("CST", 8*3600)).Unix()
	day, week := teamPeriodStarts(now)
	for _, user := range []User{admin, member} {
		require.NoError(t, DB.Create(&TeamFundingReservation{RequestID: fmt.Sprintf("member-overview-%d-%d", team.ID, user.Id), TeamID: team.ID, UserID: user.Id, ModelName: user.Username, State: "settled", Actual: 14, PromptTokens: 12, CompletionTokens: 8, DayStart: day, WeekStart: week, CreatedAt: now}).Error)
	}
	selected, err := GetTeamOverviewForMember(team.ID, admin.Id, 1, 7, now, member.Id)
	require.NoError(t, err)
	require.Equal(t, "member", selected.Scope)
	require.Equal(t, member.Id, selected.MemberID)
	require.EqualValues(t, 1, selected.Summary.Requests)
	require.EqualValues(t, 14, selected.Summary.Actual)
	require.EqualValues(t, 14, selected.PeriodUsage.DailyUsed)
	require.Len(t, selected.Models, 1)
	require.Equal(t, member.Username, selected.Models[0].ModelName)
	require.EqualValues(t, 14, selected.Trend[6].Actual)
	require.Len(t, selected.Members, 2)
	all, err := GetTeamOverview(team.ID, sys.Id, 10, 30, now)
	require.NoError(t, err)
	require.EqualValues(t, 28, all.Summary.Actual)
	mine, err := GetTeamOverviewForMember(team.ID, member.Id, 10, 7, now, member.Id)
	require.NoError(t, err)
	require.Equal(t, "mine", mine.Scope)
	require.Empty(t, mine.Members)
	_, err = GetTeamOverviewForMember(team.ID, member.Id, 10, 7, now, admin.Id)
	require.ErrorIs(t, err, ErrTeamAccess)
	_, err = GetTeamOverviewForMember(team.ID, admin.Id, 1, 7, now, sys.Id)
	require.ErrorIs(t, err, ErrTeamAccess)
	_, err = GetTeamOverviewForMember(team.ID, admin.Id, 1, 7, now, -1)
	require.ErrorIs(t, err, ErrTeamInput)
	require.NoError(t, UpdateTeamMember(team.ID, admin.Id, member.Id, 1, nil, nil, true))
	selected, err = GetTeamOverviewForMember(team.ID, admin.Id, 1, 30, now, member.Id)
	require.NoError(t, err)
	require.EqualValues(t, 14, selected.Summary.Actual)
	require.Len(t, selected.Members, 2)
	_, err = GetTeamOverviewForMember(team.ID, member.Id, 1, 7, now, member.Id)
	require.ErrorIs(t, err, ErrTeamAccess)
}

func TestTeamLimitsApplyIndependentlyPerMember(t *testing.T) {
	_, admin, member, team := setupTeamTest(t)
	require.NoError(t, DB.Create(&TeamMember{TeamID: team.ID, UserID: member.Id, Role: "member", Status: 1}).Error)
	require.NoError(t, DB.Model(&team).Updates(map[string]any{"balance": 100, "daily_limit": 5, "weekly_limit": 10}).Error)
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, time.FixedZone("CST", 8*3600)).Unix()
	id := fmt.Sprintf("member-limits-%d", team.ID)
	_, err := ReservePostpaidTeamFunding(id+"-a", team.ID, admin.Id, 0, "test", now)
	require.NoError(t, err)
	require.NoError(t, SettleTeamFunding(id+"-a", 6))
	_, err = ReservePostpaidTeamFunding(id+"-a-denied", team.ID, admin.Id, 0, "test", now)
	require.ErrorIs(t, err, ErrTeamDailyLimit)
	_, err = ReservePostpaidTeamFunding(id+"-b", team.ID, member.Id, 0, "test", now)
	require.NoError(t, err, "one member's daily use must not exhaust another's allowance")
	require.NoError(t, SettleTeamFunding(id+"-b", 4))
	_, err = ReservePostpaidTeamFunding(id+"-a-next-day", team.ID, admin.Id, 0, "test", now+86400)
	require.NoError(t, err)
	require.NoError(t, SettleTeamFunding(id+"-a-next-day", 5))
	_, err = ReservePostpaidTeamFunding(id+"-a-week-denied", team.ID, admin.Id, 0, "test", now+2*86400)
	require.ErrorIs(t, err, ErrTeamWeeklyLimit)
	_, err = ReservePostpaidTeamFunding(id+"-b-next-day", team.ID, member.Id, 0, "test", now+86400)
	require.NoError(t, err, "one member's weekly overage must not exhaust another's allowance")
	require.NoError(t, SettleTeamFunding(id+"-b-next-day", 4))
	require.NoError(t, DB.First(&team, team.ID).Error)
	require.EqualValues(t, 81, team.Balance, "all member charges still debit one shared wallet")
	_, err = ReservePostpaidTeamFunding(id+"-a-next-week", team.ID, admin.Id, 0, "test", now+7*86400)
	require.NoError(t, err)
	require.NoError(t, RefundTeamFunding(id+"-a-next-week"))
	require.NoError(t, DB.Model(&team).Update("balance", 1).Error)
	_, err = ReservePostpaidTeamFunding(id+"-b-overdraft", team.ID, member.Id, 0, "test", now+7*86400)
	require.NoError(t, err)
	require.NoError(t, SettleTeamFunding(id+"-b-overdraft", 3))
	_, err = ReservePostpaidTeamFunding(id+"-a-shared-debt", team.ID, admin.Id, 0, "test", now+7*86400)
	require.ErrorIs(t, err, ErrTeamBalance, "shared wallet debt blocks everyone even with unused member allowance")
}
