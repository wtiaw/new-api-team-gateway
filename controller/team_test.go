package controller

import (
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTeamResponsesHideSharedFundsFromMembers(t *testing.T) {
	originalRatios := ratio_setting.GroupRatio2JSONString()
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"开发":1,"测试":1.5}`))
	t.Cleanup(func() { require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(originalRatios)) })

	db := setupManageUserTestDB(t)
	require.NoError(t, model.MigrateTeams(db))
	require.NoError(t, model.MigrateTeamFunding(db))
	users := []model.User{
		{Username: "overview-system", Role: 10, Status: 1, AffCode: "sys"},
		{Username: "overview-manager", Role: 1, Status: 1, AffCode: "manager"},
		{Username: "overview-member", Role: 1, Status: 1, AffCode: "member"},
	}
	for i := range users {
		require.NoError(t, db.Create(&users[i]).Error)
	}
	team, err := model.CreateTeam(users[0].Id, 10, model.TeamCreate{Name: "Team", AllowedGroups: []string{"开发", "测试"}, DefaultGroup: "开发", AdminUserID: users[1].Id, DailyLimit: new(int64(2500000)), WeeklyLimit: new(int64(12500000))})
	require.NoError(t, err)
	require.NoError(t, db.Model(team).Update("balance", 9876543).Error)
	require.NoError(t, db.Create(&model.TeamMember{TeamID: team.ID, UserID: users[2].Id, Role: "member", Status: 1}).Error)
	for i := range users {
		for _, list := range []bool{false, true} {
			t.Run(users[i].Username+"/list="+strconv.FormatBool(list), func(t *testing.T) {
				recorder := httptest.NewRecorder()
				c, _ := gin.CreateTestContext(recorder)
				c.Request = httptest.NewRequest("GET", "/api/teams", nil)
				c.Set("id", users[i].Id)
				// The current DB role, not a stale privileged session, decides scope.
				c.Set("role", 10)
				c.Params = gin.Params{{Key: "id", Value: strconv.Itoa(team.ID)}}
				if list {
					ListTeams(c)
				} else {
					GetTeam(c)
				}
				var response struct {
					Success bool `json:"success"`
					Data    any  `json:"data"`
				}
				require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
				require.True(t, response.Success, recorder.Body.String())
				var visible map[string]any
				if list {
					rows := response.Data.([]any)
					require.Len(t, rows, 1)
					visible = rows[0].(map[string]any)
				} else {
					detail := response.Data.(map[string]any)
					visible = detail["team"].(map[string]any)
					if i == 2 {
						assert.NotContains(t, detail, "budget")
					} else {
						assert.Contains(t, detail, "budget")
					}
				}
				assert.Equal(t, []any{"开发", "测试"}, visible["allowed_groups"], "every role needs the persisted resource grant profile")
				assert.Equal(t, "开发", visible["default_group"])
				assert.EqualValues(t, 2500000, visible["daily_limit"])
				assert.EqualValues(t, 12500000, visible["weekly_limit"])
				if i == 2 {
					assert.NotContains(t, visible, "balance")
				} else {
					assert.EqualValues(t, 9876543, visible["balance"])
				}
			})
		}
	}
}

func TestTeamOverviewMemberFilterQuery(t *testing.T) {
	db := setupManageUserTestDB(t)
	require.NoError(t, model.MigrateTeams(db))
	require.NoError(t, model.MigrateTeamFunding(db))
	users := []model.User{{Username: "filter-system", Role: 10, Status: 1, AffCode: "filter-sys"}, {Username: "filter-admin", Role: 1, Status: 1, AffCode: "filter-admin"}, {Username: "filter-member", Role: 1, Status: 1, AffCode: "filter-member"}}
	for i := range users {
		require.NoError(t, db.Create(&users[i]).Error)
	}
	team, err := model.CreateTeam(users[0].Id, 10, model.TeamCreate{Name: "Member filters", AdminUserID: users[1].Id})
	require.NoError(t, err)
	require.NoError(t, db.Create(&model.TeamMember{TeamID: team.ID, UserID: users[2].Id, Role: "member", Status: 1}).Error)
	for _, tc := range []struct {
		user    int
		filter  string
		success bool
	}{
		{1, "abc", false}, {1, "-1", false}, {1, "1.5", false}, {1, "99999999999999999999999999", false},
		{1, strconv.Itoa(users[2].Id), true}, {2, strconv.Itoa(users[1].Id), false}, {2, strconv.Itoa(users[2].Id), true},
	} {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest("GET", "/api/teams/"+strconv.Itoa(team.ID)+"/overview?user_id="+tc.filter, nil)
		c.Params = gin.Params{{Key: "id", Value: strconv.Itoa(team.ID)}}
		c.Set("id", users[tc.user].Id)
		c.Set("role", 10)
		GetTeamOverview(c)
		var response struct {
			Success bool               `json:"success"`
			Data    model.TeamOverview `json:"data"`
		}
		require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
		assert.Equal(t, tc.success, response.Success, recorder.Body.String())
		if tc.success && tc.user == 2 {
			assert.Empty(t, response.Data.Members)
			assert.Equal(t, "mine", response.Data.Scope)
		}
	}
}
