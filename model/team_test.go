package model

import (
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func setupTeamTest(t *testing.T) (User, User, User, Team) {
	t.Helper()
	old, oldType := DB, common.MainDatabaseType()
	var dialect gorm.Dialector = sqlite.Open(":memory:")
	switch os.Getenv("TEAM_TEST_DIALECT") {
	case "mysql":
		dialect = mysql.Open(os.Getenv("TEAM_TEST_DSN"))
	case "postgres":
		dialect = postgres.Open(os.Getenv("TEAM_TEST_DSN"))
	}
	db, err := gorm.Open(dialect, &gorm.Config{})
	require.NoError(t, err)
	DB = db
	if os.Getenv("TEAM_TEST_DIALECT") == "mysql" {
		common.SetMainDatabaseType(common.DatabaseTypeMySQL)
	} else if os.Getenv("TEAM_TEST_DIALECT") == "postgres" {
		common.SetMainDatabaseType(common.DatabaseTypePostgreSQL)
	} else {
		common.SetMainDatabaseType(common.DatabaseTypeSQLite)
		sqlDB, _ := db.DB()
		sqlDB.SetMaxOpenConns(1)
	}
	t.Cleanup(func() {
		DB = old
		common.SetMainDatabaseType(oldType)
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
	})
	require.NoError(t, db.AutoMigrate(&User{}))
	require.NoError(t, MigrateTeams(db))
	require.NoError(t, MigrateTeamFunding(db))
	users := []User{{Username: "sys", Role: 10, Status: 1, Quota: 111}, {Username: "manager", Role: 1, Status: 1, Quota: 222}, {Username: "member", Role: 1, Status: 1, Quota: 333}}
	for i := range users {
		users[i].Username += common.GetRandomString(6)
		users[i].AffCode = common.GetRandomString(16)
		require.NoError(t, db.Create(&users[i]).Error)
	}
	team, err := CreateTeam(users[0].Id, 10, TeamCreate{Name: "Team", AdminUserID: users[1].Id})
	require.NoError(t, err)
	return users[0], users[1], users[2], *team
}

func TestTeamManagementPermissionsAndBalance(t *testing.T) {
	sys, admin, member, team := setupTeamTest(t)
	require.Error(t, RequireTeamAccess(team.ID, member.Id, 1, false))
	require.NoError(t, RequireTeamAccess(team.ID, admin.Id, 1, true))
	_, err := CreateTeam(admin.Id, 1, TeamCreate{Name: "Unauthorized"})
	require.Error(t, err)
	status := 2
	_, err = UpdateTeam(team.ID, admin.Id, 1, TeamUpdate{Status: &status})
	require.Error(t, err)
	role := "admin"
	require.Error(t, UpdateTeamMember(team.ID, admin.Id, admin.Id, 1, &role, nil, false))
	first, err := AdjustTeamBalance(team.ID, sys.Id, 10, "add", 100, "fund", "operation-1")
	require.NoError(t, err)
	require.EqualValues(t, 100, first.After)
	retry, err := AdjustTeamBalance(team.ID, sys.Id, 10, "add", 100, "fund", "operation-1")
	require.NoError(t, err)
	require.Equal(t, first.ID, retry.ID)
	_, err = AdjustTeamBalance(team.ID, sys.Id, 10, "add", 101, "fund", "operation-1")
	require.Error(t, err)
	_, err = AdjustTeamBalance(team.ID, admin.Id, 1, "add", 1, "fund", "operation-2")
	require.Error(t, err)
	_, err = AdjustTeamBalance(team.ID, sys.Id, 10, "subtract", 101, "fund", "operation-3")
	require.Error(t, err)
	var unchanged User
	require.NoError(t, DB.First(&unchanged, member.Id).Error)
	require.Equal(t, 333, unchanged.Quota)
}

func TestTeamInvitationSingleUseExpiryRevocation(t *testing.T) {
	sys, admin, member, team := setupTeamTest(t)
	invite, raw, err := CreateTeamInvitation(team.ID, admin.Id, 1, 7)
	require.NoError(t, err)
	require.Len(t, raw, 43)
	require.NotEqual(t, raw, invite.TokenHash)
	_, err = AcceptTeamInvitation(raw, member.Id)
	require.NoError(t, err)
	_, err = AcceptTeamInvitation(raw, member.Id)
	require.NoError(t, err)
	_, err = AcceptTeamInvitation(raw, sys.Id)
	require.Error(t, err)
	require.NoError(t, RequireTeamAccess(team.ID, member.Id, 1, false))
	require.Error(t, RequireTeamAccess(team.ID, member.Id, 1, true))
	require.NoError(t, UpdateTeamMember(team.ID, admin.Id, member.Id, 1, nil, nil, true))
	require.Error(t, RequireTeamAccess(team.ID, member.Id, 1, false))
	_, err = AcceptTeamInvitation(raw, member.Id)
	require.Error(t, err)
	exp, token, err := CreateTeamInvitation(team.ID, admin.Id, 1, 1)
	require.NoError(t, err)
	require.NoError(t, DB.Model(&TeamInvitation{}).Where("id = ?", exp.ID).Update("expires_at", time.Now().Unix()-1).Error)
	_, err = AcceptTeamInvitation(token, member.Id)
	require.Error(t, err)
	rev, token, err := CreateTeamInvitation(team.ID, admin.Id, 1, 1)
	require.NoError(t, err)
	require.NoError(t, RevokeTeamInvitation(team.ID, rev.ID, admin.Id, 1))
	_, err = AcceptTeamInvitation(token, member.Id)
	require.Error(t, err)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", admin.Id).Update("status", 2).Error)
	require.Error(t, RequireTeamAccess(team.ID, admin.Id, 1, true))
}

func TestTeamLimitsAndManagerIsolation(t *testing.T) {
	sys, admin, member, team := setupTeamTest(t)
	second, err := CreateTeam(sys.Id, 10, TeamCreate{Name: "Other team", AdminUserID: sys.Id})
	require.NoError(t, err)
	require.Error(t, RequireTeamAccess(second.ID, admin.Id, 1, true))
	_, err = UpdateTeam(second.ID, admin.Id, 1, TeamUpdate{Name: new("bad")})
	require.Error(t, err)
	_, _, err = CreateTeamInvitation(second.ID, admin.Id, 1, 7)
	require.Error(t, err)
	_, err = ListTeamBalanceOperations(team.ID, member.Id, 1)
	require.Error(t, err)
	_, err = UpdateTeam(team.ID, admin.Id, 1, TeamUpdate{DailyLimit: []byte("0"), WeeklyLimit: []byte("123")})
	require.NoError(t, err)
	got, _, err := GetTeam(team.ID, admin.Id, 1)
	require.NoError(t, err)
	require.EqualValues(t, 0, *got.DailyLimit)
	require.EqualValues(t, 123, *got.WeeklyLimit)
	_, err = UpdateTeam(team.ID, admin.Id, 1, TeamUpdate{DailyLimit: []byte("null")})
	require.NoError(t, err)
	got, _, err = GetTeam(team.ID, admin.Id, 1)
	require.NoError(t, err)
	require.Nil(t, got.DailyLimit)
	require.EqualValues(t, 123, *got.WeeklyLimit)
	_, err = UpdateTeam(team.ID, admin.Id, 1, TeamUpdate{DailyLimit: []byte("-1")})
	require.Error(t, err)
	_, err = UpdateTeam(team.ID, sys.Id, 10, TeamUpdate{Status: new(2)})
	require.NoError(t, err)
	require.NoError(t, RequireTeamAccess(team.ID, admin.Id, 1, true))
	require.NoError(t, RequireTeamAccess(team.ID, sys.Id, 10, true))
	_, token, err := CreateTeamInvitation(team.ID, sys.Id, 10, 7)
	require.NoError(t, err)
	_, err = AcceptTeamInvitation(token, member.Id)
	require.Error(t, err)
	var user User
	require.NoError(t, DB.First(&user, admin.Id).Error)
	require.Equal(t, 1, user.Role)
}

func TestTeamConcurrentInvitationRedemption(t *testing.T) {
	sys, admin, member, team := setupTeamTest(t)
	_, raw, err := CreateTeamInvitation(team.ID, admin.Id, 1, 7)
	require.NoError(t, err)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, id := range []int{sys.Id, member.Id} {
		wg.Go(func() { _, err := AcceptTeamInvitation(raw, id); results <- err })
	}
	wg.Wait()
	close(results)
	accepted := 0
	for err := range results {
		if err == nil {
			accepted++
		}
	}
	require.Equal(t, 1, accepted)
	var count int64
	require.NoError(t, DB.Model(&TeamInvitation{}).Where("team_id = ? AND accepted_by > 0", team.ID).Count(&count).Error)
	require.EqualValues(t, 1, count)
}

func TestTeamConcurrentBalanceIdempotencyAndAudit(t *testing.T) {
	sys, admin, _, team := setupTeamTest(t)
	var wg sync.WaitGroup
	results := make(chan error, 8)
	for range 8 {
		wg.Go(func() {
			_, err := AdjustTeamBalance(team.ID, sys.Id, 10, "add", 50, "concurrent funding", "retry-id")
			results <- err
		})
	}
	wg.Wait()
	close(results)
	for err := range results {
		require.NoError(t, err)
	}
	got, _, err := GetTeam(team.ID, sys.Id, 10)
	require.NoError(t, err)
	require.EqualValues(t, 50, got.Balance)
	operations, err := ListTeamBalanceOperations(team.ID, admin.Id, 1)
	require.NoError(t, err)
	require.Len(t, operations, 1)
	require.NoError(t, UpdateTeamMember(team.ID, sys.Id, admin.Id, 10, nil, new(2), false))
	var event TeamManagementEvent
	require.NoError(t, DB.Where("team_id = ? AND action = ?", team.ID, "team.member.update").Order("id desc").First(&event).Error)
	require.Contains(t, event.Before, `"status":1`)
	require.Contains(t, event.After, `"status":2`)
}

func TestTeamConcurrentSameUserInvitationReplay(t *testing.T) {
	_, admin, member, team := setupTeamTest(t)
	_, raw, err := CreateTeamInvitation(team.ID, admin.Id, 1, 7)
	require.NoError(t, err)
	var wg sync.WaitGroup
	results := make(chan error, 8)
	for range 8 {
		wg.Go(func() { _, err := AcceptTeamInvitation(raw, member.Id); results <- err })
	}
	wg.Wait()
	close(results)
	for err := range results {
		require.NoError(t, err)
	}
	var count int64
	require.NoError(t, DB.Model(&TeamMember{}).Where("team_id = ? AND user_id = ?", team.ID, member.Id).Count(&count).Error)
	require.EqualValues(t, 1, count)
}

func TestTeamBalancePreservesRefundHeadroom(t *testing.T) {
	sys, admin, _, team := setupTeamTest(t)
	_, err := AdjustTeamBalance(team.ID, sys.Id, 10, "add", int64(common.MaxWalletQuota), "fund maximum", "fund-max")
	require.NoError(t, err)
	requestID := "refund-headroom-" + common.GetRandomString(16)
	_, err = ReserveTeamFunding(requestID, team.ID, admin.Id, 0, 1, "test", time.Now().Unix())
	require.NoError(t, err)
	_, err = AdjustTeamBalance(team.ID, sys.Id, 10, "add", 1, "must retain refund capacity", "add-reserved")
	require.ErrorIs(t, err, ErrTeamInput)
	_, err = AdjustTeamBalance(team.ID, sys.Id, 10, "override", int64(common.MaxWalletQuota), "must retain refund capacity", "override-reserved")
	require.ErrorIs(t, err, ErrTeamInput)
	require.NoError(t, RefundTeamFunding(requestID))
	got, _, err := GetTeam(team.ID, sys.Id, 10)
	require.NoError(t, err)
	require.EqualValues(t, common.MaxWalletQuota, got.Balance)
	operations, err := ListTeamBalanceOperations(team.ID, sys.Id, 10)
	require.NoError(t, err)
	require.Len(t, operations, 1)
}

func TestTeamPersonalBackupSystemControl(t *testing.T) {
	sys, admin, _, team := setupTeamTest(t)
	require.True(t, team.AllowPersonalBackup)
	_, err := UpdateTeam(team.ID, admin.Id, 1, TeamUpdate{AllowPersonalBackup: new(false)})
	require.ErrorIs(t, err, ErrTeamAccess)
	updated, err := UpdateTeam(team.ID, sys.Id, 10, TeamUpdate{AllowPersonalBackup: new(false)})
	require.NoError(t, err)
	require.False(t, updated.AllowPersonalBackup)
	reloaded, _, err := GetTeam(team.ID, sys.Id, 10)
	require.NoError(t, err)
	require.False(t, reloaded.AllowPersonalBackup)
	created, err := CreateTeam(sys.Id, 10, TeamCreate{Name: "Backup disabled", AdminUserID: sys.Id, AllowPersonalBackup: new(false)})
	require.NoError(t, err)
	require.False(t, created.AllowPersonalBackup)
	require.NoError(t, MigrateTeams(DB))
	reloaded, _, err = GetTeam(team.ID, sys.Id, 10)
	require.NoError(t, err)
	require.False(t, reloaded.AllowPersonalBackup)
}

func TestTeamUsageFullHistoryScopeAndPaging(t *testing.T) {
	sys, admin, member, team := setupTeamTest(t)
	_, token, err := CreateTeamInvitation(team.ID, admin.Id, 1, 7)
	require.NoError(t, err)
	_, err = AcceptTeamInvitation(token, member.Id)
	require.NoError(t, err)
	prefix := common.GetRandomString(16)
	records := make([]TeamFundingReservation, 0, 602)
	for i := range 601 {
		records = append(records, TeamFundingReservation{RequestID: fmt.Sprintf("%s-%04d", prefix, i), TeamID: team.ID, UserID: admin.Id, ModelName: "history-visible", State: "settled", CreatedAt: int64(i)})
	}
	records = append(records, TeamFundingReservation{RequestID: prefix + "-own", TeamID: team.ID, UserID: member.Id, ModelName: "history-own", State: "settled"})
	require.NoError(t, DB.CreateInBatches(records, 50).Error)
	query, err := TeamUsageQuery(team.ID, admin.Id, 1, "history")
	require.NoError(t, err)
	var total int64
	require.NoError(t, query.Count(&total).Error)
	require.EqualValues(t, 602, total)
	var secondPage []TeamFundingReservation
	require.NoError(t, query.Order("created_at DESC, request_id DESC").Offset(500).Limit(500).Find(&secondPage).Error)
	require.Len(t, secondPage, 102)
	query, err = TeamUsageQuery(team.ID, admin.Id, 1, "history-visible")
	require.NoError(t, err)
	rows, err := query.Rows()
	require.NoError(t, err)
	exported := 0
	for rows.Next() {
		exported++
	}
	require.NoError(t, rows.Err())
	require.NoError(t, rows.Close())
	require.Equal(t, 601, exported)
	query, err = TeamUsageQuery(team.ID, member.Id, 1, "history")
	require.NoError(t, err)
	require.NoError(t, query.Count(&total).Error)
	require.EqualValues(t, 1, total)
	query, err = TeamUsageQuery(team.ID, member.Id, 1, "history-visible")
	require.NoError(t, err)
	require.NoError(t, query.Count(&total).Error)
	require.Zero(t, total)
	query, err = TeamUsageQuery(team.ID, sys.Id, 10, "")
	require.NoError(t, err)
	require.NoError(t, query.Count(&total).Error)
	require.EqualValues(t, 602, total)
}

func TestTeamBackupSettingMigrationPreservesExistingChoice(t *testing.T) {
	_, _, _, team := setupTeamTest(t)
	// Simulate the first local team schema, before the backup setting existed.
	require.NoError(t, DB.Migrator().DropColumn(&Team{}, "AllowPersonalBackup"))
	require.NoError(t, MigrateTeams(DB))
	require.NoError(t, DB.First(&team, team.ID).Error)
	require.True(t, team.AllowPersonalBackup)
	require.NoError(t, DB.Model(&team).Update("allow_personal_backup", false).Error)
	require.NoError(t, MigrateTeams(DB))
	require.NoError(t, DB.First(&team, team.ID).Error)
	require.False(t, team.AllowPersonalBackup, "repeated startup must preserve an explicit system-admin restriction")
}

func TestTeamMultipleActiveMembershipsAndIndependentAdministration(t *testing.T) {
	sys, admin, member, first := setupTeamTest(t)
	second, err := CreateTeam(sys.Id, 10, TeamCreate{Name: "Second", AdminUserID: sys.Id})
	require.NoError(t, err)
	_, err = CreateTeam(sys.Id, 10, TeamCreate{Name: "Another administered team", AdminUserID: admin.Id})
	require.NoError(t, err)
	_, err = UpdateTeam(second.ID, sys.Id, 10, TeamUpdate{AdminUserID: &admin.Id})
	require.NoError(t, err)
	_, firstToken, err := CreateTeamInvitation(first.ID, sys.Id, 10, 7)
	require.NoError(t, err)
	_, secondToken, err := CreateTeamInvitation(second.ID, sys.Id, 10, 7)
	require.NoError(t, err)
	_, err = AcceptTeamInvitation(firstToken, member.Id)
	require.NoError(t, err)
	_, err = AcceptTeamInvitation(firstToken, member.Id)
	require.NoError(t, err)
	_, sameTeamToken, err := CreateTeamInvitation(first.ID, sys.Id, 10, 7)
	require.NoError(t, err)
	_, err = AcceptTeamInvitation(sameTeamToken, member.Id)
	require.NoError(t, err)
	// A disabled team still owns its active memberships.
	_, err = UpdateTeam(first.ID, sys.Id, 10, TeamUpdate{Status: new(2)})
	require.NoError(t, err)
	_, err = AcceptTeamInvitation(secondToken, member.Id)
	require.NoError(t, err, "a disabled first team must not block joining another team")
	require.NoError(t, UpdateTeamMember(first.ID, sys.Id, member.Id, 10, nil, nil, true))
	_, err = AcceptTeamInvitation(secondToken, member.Id)
	require.NoError(t, err, "rejected invitations must remain usable after leaving the previous team")
	require.NoError(t, UpdateTeamMember(first.ID, sys.Id, member.Id, 10, nil, new(1), false))
	_, err = UpdateTeam(first.ID, sys.Id, 10, TeamUpdate{AdminUserID: &member.Id})
	require.NoError(t, err)
	require.NoError(t, UpdateTeamMember(second.ID, sys.Id, member.Id, 10, nil, nil, true))
	require.NoError(t, UpdateTeamMember(first.ID, sys.Id, member.Id, 10, nil, new(1), false), "reactivation succeeds after the other membership is removed")
	var unchanged User
	require.NoError(t, DB.First(&unchanged, member.Id).Error)
	require.Equal(t, member.Quota, unchanged.Quota)
	// Persisted system administrators may belong to multiple teams.
	_, token, err := CreateTeamInvitation(first.ID, sys.Id, 10, 7)
	require.NoError(t, err)
	_, err = UpdateTeam(first.ID, sys.Id, 10, TeamUpdate{Status: new(1)})
	require.NoError(t, err)
	_, err = AcceptTeamInvitation(token, sys.Id)
	require.NoError(t, err)
	_, err = CreateTeam(sys.Id, 10, TeamCreate{Name: "System third", AdminUserID: sys.Id})
	require.NoError(t, err)
}

func TestTeamConcurrentCrossTeamMembership(t *testing.T) {
	for _, operation := range []string{"invitation", "create", "appoint", "reactivate"} {
		t.Run(operation, func(t *testing.T) {
			sys, _, member, first := setupTeamTest(t)
			second, err := CreateTeam(sys.Id, 10, TeamCreate{Name: "Second", AdminUserID: sys.Id})
			require.NoError(t, err)
			tokens := make([]string, 2)
			for i, id := range []int{first.ID, second.ID} {
				_, tokens[i], err = CreateTeamInvitation(id, sys.Id, 10, 7)
				require.NoError(t, err)
			}
			if operation == "reactivate" {
				require.NoError(t, DB.Create(&TeamMember{TeamID: first.ID, UserID: member.Id, Role: "member", Status: 2}).Error)
			}
			start := make(chan struct{})
			results := make(chan error, 2)
			var wg sync.WaitGroup
			wg.Go(func() {
				<-start
				var err error
				switch operation {
				case "create":
					_, err = CreateTeam(sys.Id, 10, TeamCreate{Name: "Concurrent", AdminUserID: member.Id})
				case "appoint":
					_, err = UpdateTeam(first.ID, sys.Id, 10, TeamUpdate{AdminUserID: &member.Id})
				case "reactivate":
					err = UpdateTeamMember(first.ID, sys.Id, member.Id, 10, nil, new(1), false)
				default:
					_, err = AcceptTeamInvitation(tokens[0], member.Id)
				}
				results <- err
			})
			wg.Go(func() { <-start; _, err := AcceptTeamInvitation(tokens[1], member.Id); results <- err })
			close(start)
			wg.Wait()
			close(results)
			accepted := 0
			for err := range results {
				if err == nil {
					accepted++
				} else {
					require.NoError(t, err)
				}
			}
			require.Equal(t, 2, accepted)
			var count int64
			require.NoError(t, DB.Model(&TeamMember{}).Where("user_id = ? AND status = ?", member.Id, 1).Count(&count).Error)
			require.EqualValues(t, 2, count)
		})
	}
}

func TestTeamHistoricalMultipleMembershipPreserved(t *testing.T) {
	sys, admin, _, first := setupTeamTest(t)
	second, err := CreateTeam(sys.Id, 10, TeamCreate{Name: "Historical", AdminUserID: sys.Id})
	require.NoError(t, err)
	require.NoError(t, DB.Create(&TeamMember{TeamID: second.ID, UserID: admin.Id, Role: "member", Status: 1}).Error)
	require.NoError(t, UpdateTeamMember(first.ID, sys.Id, admin.Id, 10, new("member"), nil, false))
	var count int64
	require.NoError(t, DB.Model(&TeamMember{}).Where("user_id = ? AND status = ?", admin.Id, 1).Count(&count).Error)
	require.EqualValues(t, 2, count, "historical data must never be unlinked automatically")
	require.NoError(t, UpdateTeamMember(second.ID, sys.Id, admin.Id, 10, nil, nil, true))
	require.NoError(t, UpdateTeamMember(first.ID, sys.Id, admin.Id, 10, new("member"), nil, false))
}

func TestTeamRemovedMemberHiddenWhileDisabledMemberRemains(t *testing.T) {
	_, admin, member, team := setupTeamTest(t)
	_, raw, err := CreateTeamInvitation(team.ID, admin.Id, 1, 7)
	require.NoError(t, err)
	joined, err := AcceptTeamInvitation(raw, member.Id)
	require.NoError(t, err)
	originalID := joined.ID
	require.NoError(t, UpdateTeamMember(team.ID, admin.Id, member.Id, 1, nil, new(2), false))
	rows, err := ListTeamMembers(team.ID, admin.Id, 1)
	require.NoError(t, err)
	require.Len(t, rows, 2, "disabled membership remains manageable")
	require.NoError(t, UpdateTeamMember(team.ID, admin.Id, member.Id, 1, nil, nil, true))
	rows, err = ListTeamMembers(team.ID, admin.Id, 1)
	require.NoError(t, err)
	require.Len(t, rows, 1, "removed membership must disappear from the member list")
	require.Equal(t, admin.Id, rows[0].UserID)
	var stored TeamMember
	require.NoError(t, DB.First(&stored, originalID).Error, "membership identity is retained for history")
	require.Equal(t, TeamMemberStatusRemoved, stored.Status)
	require.NoError(t, DB.Model(&stored).Update("role", "admin").Error)
	require.Error(t, RequireTeamAccess(team.ID, member.Id, 1, false))
	_, err = AcceptTeamInvitation(raw, member.Id)
	require.Error(t, err, "an already redeemed invitation cannot restore a removed member")
	_, fresh, err := CreateTeamInvitation(team.ID, admin.Id, 1, 7)
	require.NoError(t, err)
	rejoined, err := AcceptTeamInvitation(fresh, member.Id)
	require.NoError(t, err, "a fresh invitation can add a removed member back")
	require.Equal(t, originalID, rejoined.ID)
	require.Equal(t, 1, rejoined.Status)
	require.Equal(t, "member", rejoined.Role)
	require.NoError(t, RequireTeamAccess(team.ID, member.Id, 1, false))
	require.NoError(t, UpdateTeamMember(team.ID, admin.Id, member.Id, 1, nil, new(2), false))
	_, disabledInvite, err := CreateTeamInvitation(team.ID, admin.Id, 1, 7)
	require.NoError(t, err)
	_, err = AcceptTeamInvitation(disabledInvite, member.Id)
	require.Error(t, err, "a disabled member cannot use an invite to bypass administrator suspension")
	var user User
	require.NoError(t, DB.First(&user, member.Id).Error)
	require.Equal(t, 333, user.Quota)
}

func TestTeamInvitationListShowsAcceptorWithoutLeakingSecrets(t *testing.T) {
	_, admin, member, team := setupTeamTest(t)
	invite, raw, err := CreateTeamInvitation(team.ID, admin.Id, 1, 7)
	require.NoError(t, err)
	_, err = AcceptTeamInvitation(raw, member.Id)
	require.NoError(t, err)
	rows, err := ListTeamInvitations(team.ID, admin.Id, 1)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, member.Id, rows[0].AcceptedBy)
	require.Equal(t, member.Username, rows[0].AcceptedUsername)
	encoded, err := common.Marshal(rows)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), raw)
	require.NotContains(t, string(encoded), invite.TokenHash)
	_, err = ListTeamInvitations(team.ID, member.Id, 10)
	require.ErrorIs(t, err, ErrTeamAccess)
	require.NoError(t, UpdateTeamMember(team.ID, admin.Id, member.Id, 1, nil, nil, true))
	rows, err = ListTeamInvitations(team.ID, admin.Id, 1)
	require.NoError(t, err)
	require.Equal(t, member.Username, rows[0].AcceptedUsername)
}

func TestTeamGroupGrantsAreSystemManaged(t *testing.T) {
	sys, admin, _, team := setupTeamTest(t)
	old := ratio_setting.GroupRatio2JSONString()
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"development":1,"testing":2}`))
	t.Cleanup(func() { require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(old)) })
	groups := []string{"development", "testing"}
	defaultGroup := "development"
	_, err := UpdateTeam(team.ID, admin.Id, 1, TeamUpdate{AllowedGroups: &groups, DefaultGroup: &defaultGroup})
	require.ErrorIs(t, err, ErrTeamAccess)
	updated, err := UpdateTeam(team.ID, sys.Id, 10, TeamUpdate{AllowedGroups: &groups, DefaultGroup: &defaultGroup})
	require.NoError(t, err)
	require.Equal(t, groups, updated.AllowedGroups)
	require.Equal(t, defaultGroup, updated.DefaultGroup)
	for _, invalid := range []TeamUpdate{
		{AllowedGroups: new([]string{"auto"}), DefaultGroup: new("auto")},
		{AllowedGroups: new([]string{"development", "development"})},
		{AllowedGroups: new([]string{"missing"})},
		{DefaultGroup: new("testing-missing")},
		{AllowedGroups: new([]string{})},
	} {
		_, err = UpdateTeam(team.ID, sys.Id, 10, invalid)
		require.ErrorIs(t, err, ErrTeamInput)
	}
	updated, err = UpdateTeam(team.ID, sys.Id, 10, TeamUpdate{AllowedGroups: new([]string{}), DefaultGroup: new("")})
	require.NoError(t, err)
	require.Empty(t, updated.AllowedGroups)
	require.Empty(t, updated.DefaultGroup)
}

func TestTeamResourceGroupHasOneOwnerUntilExplicitlyReleased(t *testing.T) {
	sys, _, _, first := setupTeamTest(t)
	original := ratio_setting.GroupRatio2JSONString()
	stem := fmt.Sprintf("exclusive-%d", first.ID)
	upper, lower := stem+"-A", stem+"-a"
	encoded, err := common.Marshal(map[string]float64{upper: 1, lower: 1.5})
	require.NoError(t, err)
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(string(encoded)))
	t.Cleanup(func() { require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(original)) })
	_, err = UpdateTeam(first.ID, sys.Id, 10, TeamUpdate{AllowedGroups: new([]string{upper}), DefaultGroup: &upper})
	require.NoError(t, err)
	second, err := CreateTeam(sys.Id, 10, TeamCreate{Name: "Distinct exact group", AdminUserID: sys.Id, AllowedGroups: []string{lower}, DefaultGroup: lower})
	require.NoError(t, err, "resource group names keep their exact case on all databases")
	_, err = CreateTeam(sys.Id, 10, TeamCreate{Name: "Conflicting resource group", AdminUserID: sys.Id, AllowedGroups: []string{upper}, DefaultGroup: upper})
	require.EqualError(t, err, "A resource group can only belong to one team")
	_, err = UpdateTeam(first.ID, sys.Id, 10, TeamUpdate{Status: new(2)})
	require.NoError(t, err)
	_, err = UpdateTeam(second.ID, sys.Id, 10, TeamUpdate{AllowedGroups: new([]string{upper, lower}), DefaultGroup: &lower})
	require.EqualError(t, err, "A resource group can only belong to one team", "disabling a team must not transfer ownership")
	stored, _, err := GetTeam(second.ID, sys.Id, 10)
	require.NoError(t, err)
	require.Equal(t, []string{lower}, stored.AllowedGroups, "failed assignment rolls back all authorization changes")
	_, err = UpdateTeam(first.ID, sys.Id, 10, TeamUpdate{AllowedGroups: new([]string{}), DefaultGroup: new("")})
	require.NoError(t, err)
	_, err = UpdateTeam(second.ID, sys.Id, 10, TeamUpdate{AllowedGroups: new([]string{upper, lower}), DefaultGroup: &lower})
	require.NoError(t, err)
	require.NoError(t, MigrateTeams(DB))
	require.NoError(t, MigrateTeams(DB), "repeated startup preserves the explicit owner")
	_, err = UpdateTeam(first.ID, sys.Id, 10, TeamUpdate{AllowedGroups: new([]string{upper}), DefaultGroup: &upper})
	require.EqualError(t, err, "A resource group can only belong to one team")
}

func TestTeamConcurrentResourceGroupClaimsHaveOneOwner(t *testing.T) {
	sys, _, _, first := setupTeamTest(t)
	second, err := CreateTeam(sys.Id, 10, TeamCreate{Name: "Second claimant", AdminUserID: sys.Id})
	require.NoError(t, err)
	original := ratio_setting.GroupRatio2JSONString()
	group := fmt.Sprintf("claimed-%d", first.ID)
	encoded, err := common.Marshal(map[string]float64{group: 1})
	require.NoError(t, err)
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(string(encoded)))
	t.Cleanup(func() { require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(original)) })
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, id := range []int{first.ID, second.ID} {
		wg.Go(func() {
			<-start
			_, err := UpdateTeam(id, sys.Id, 10, TeamUpdate{AllowedGroups: new([]string{group}), DefaultGroup: &group})
			results <- err
		})
	}
	close(start)
	wg.Wait()
	close(results)
	winners := 0
	for err := range results {
		if err == nil {
			winners++
		} else {
			require.EqualError(t, err, "A resource group can only belong to one team")
		}
	}
	require.Equal(t, 1, winners)
	var owners []Team
	require.NoError(t, DB.Where("id IN ?", []int{first.ID, second.ID}).Find(&owners).Error)
	granted := 0
	for _, owner := range owners {
		if len(owner.AllowedGroups) == 1 {
			granted++
		}
	}
	require.Equal(t, 1, granted, "the authorization snapshot and unique ownership must commit together")
}

func TestTeamGroupOwnershipMigrationBackfillsAndRejectsLegacyOverlap(t *testing.T) {
	sys, _, _, first := setupTeamTest(t)
	second, err := CreateTeam(sys.Id, 10, TeamCreate{Name: "Legacy second team", AdminUserID: sys.Id})
	require.NoError(t, err)
	group := fmt.Sprintf("legacy-grant-%d", first.ID)
	encoded, err := common.Marshal([]string{group})
	require.NoError(t, err)
	// Simulate a release that stored grants only on teams, without the guard.
	require.NoError(t, DB.Model(&Team{}).Where("id = ?", first.ID).Update("allowed_groups", string(encoded)).Error)
	orphan := TeamGroupGrant{GroupHash: teamGroupHash(group), GroupName: group, TeamID: -1}
	require.NoError(t, DB.Create(&orphan).Error)
	require.NoError(t, MigrateTeams(DB))
	var owner TeamGroupGrant
	require.NoError(t, DB.First(&owner, "group_hash = ?", orphan.GroupHash).Error)
	require.Equal(t, first.ID, owner.TeamID, "orphan guards cannot prevent valid legacy backfill")
	require.NoError(t, MigrateTeams(DB))
	require.NoError(t, DB.Model(&Team{}).Where("id = ?", second.ID).Update("allowed_groups", string(encoded)).Error)
	t.Cleanup(func() {
		require.NoError(t, DB.Model(&Team{}).Where("id = ?", second.ID).Update("allowed_groups", "[]").Error)
	})
	require.ErrorIs(t, MigrateTeams(DB), ErrTeamGroupConflict, "overlapping legacy grants require explicit administrator resolution")
	require.NoError(t, DB.First(&owner, "group_hash = ?", orphan.GroupHash).Error)
	require.Equal(t, first.ID, owner.TeamID, "failed migration rolls back the derived guard atomically")
	var stored Team
	require.NoError(t, DB.First(&stored, second.ID).Error)
	require.Equal(t, []string{group}, stored.AllowedGroups, "migration never silently rewrites legacy authorization")
}
