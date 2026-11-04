package service

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestTeamRequestDefaultsReachUpstreamBody(t *testing.T) {
	for _, tc := range []struct {
		name    string
		body    string
		request dto.Request
		teamID  int
		field   string
		want    int
	}{
		{"responses omitted", `{"model":"fixture","input":[],"store":false}`, &dto.OpenAIResponsesRequest{}, 1, "max_output_tokens", 4096},
		{"responses explicit", `{"model":"fixture","input":[],"max_output_tokens":128}`, &dto.OpenAIResponsesRequest{}, 1, "max_output_tokens", 128},
		{"responses explicit zero", `{"model":"fixture","input":[],"max_output_tokens":0}`, &dto.OpenAIResponsesRequest{}, 1, "max_output_tokens", 0},
		{"responses personal", `{"model":"fixture","input":[]}`, &dto.OpenAIResponsesRequest{}, 0, "max_output_tokens", 0},
		{"chat omitted", `{"model":"fixture","messages":[]}`, &dto.GeneralOpenAIRequest{}, 1, "max_tokens", 4096},
		{"chat completion bound", `{"model":"fixture","messages":[],"max_completion_tokens":128}`, &dto.GeneralOpenAIRequest{}, 1, "max_completion_tokens", 128},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest("POST", "/v1/responses", strings.NewReader(tc.body))
			c.Request.Header.Set("Content-Type", "application/json")
			c.Set("team_key_policy", &model.TeamKeyPolicy{TeamID: tc.teamID})
			require.NoError(t, common.Unmarshal([]byte(tc.body), tc.request))
			require.NoError(t, ApplyTeamRequestDefaults(c, tc.request))
			defer common.CleanupBodyStorage(c)
			body, err := io.ReadAll(c.Request.Body)
			require.NoError(t, err)
			var fields map[string]json.RawMessage
			require.NoError(t, common.Unmarshal(body, &fields))
			var limit int
			if fields[tc.field] != nil {
				require.NoError(t, common.Unmarshal(fields[tc.field], &limit))
			}
			assert.Equal(t, tc.want, limit)
			assert.Equal(t, tc.want, tc.request.GetTokenCountMeta().MaxTokens)
		})
	}
}

func TestTeamPostpaidCodexContextSettlesActualWithoutQuote(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	previous := model.DB
	model.DB = db
	t.Cleanup(func() { model.DB = previous })
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Team{}, &model.TeamMember{}, &model.TeamFundingReservation{}, &model.Channel{}))
	user := model.User{Username: "postpaid-system", Role: common.RoleAdminUser, Status: common.UserStatusEnabled}
	require.NoError(t, db.Create(&user).Error)
	team := model.Team{Name: "Postpaid", Status: 1, AllowPersonalBackup: true, Balance: 5, DailyLimit: new(int64(5)), WeeklyLimit: new(int64(5))}
	require.NoError(t, db.Create(&team).Error)
	oldCache := common.MemoryCacheEnabled
	common.MemoryCacheEnabled = false
	t.Cleanup(func() { common.MemoryCacheEnabled = oldCache })
	channel := model.Channel{Name: "Development upstream", Group: "development", Status: common.ChannelStatusEnabled, Key: "fixture"}
	require.NoError(t, db.Create(&channel).Error)
	for i, body := range []string{
		`{"input":[{"type":"reasoning","encrypted_content":"opaque-context"},{"type":"compaction","encrypted_content":"opaque-compaction"}],"tools":[{"type":"web_search"}],"previous_response_id":"stored-context"}`,
		`{"input":[{"role":"user","content":[{"type":"input_image","image_url":"data:fixture"}]}]}`,
	} {
		require.NoError(t, db.Model(&team).Update("balance", 5).Error)
		require.NoError(t, db.Where("team_id = ?", team.ID).Delete(&model.TeamFundingReservation{}).Error)
		request := &dto.OpenAIResponsesRequest{}
		require.NoError(t, common.Unmarshal([]byte(body), request))
		before, err := common.Marshal(request)
		require.NoError(t, err)
		info := &relaycommon.RelayInfo{RequestId: fmt.Sprintf("codex-%d", i), UserId: user.Id, IsPlayground: true, Request: request, UsingGroup: "development", ChannelMeta: &relaycommon.ChannelMeta{ChannelId: channel.Id}}
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body))
		policy := &model.TeamKeyPolicy{Mode: "team_only", TeamID: team.ID, UserID: user.Id}
		if i == 1 {
			policy.Mode = "personal_first"
		}
		session, apiErr := newPolicyBillingSession(c, info, 1000000, policy)
		require.Nil(t, apiErr)
		require.NoError(t, session.Reserve(2000000))
		require.NoError(t, session.ReserveBeforeSubmit(2000000))
		require.Zero(t, session.GetPreConsumedQuota())
		after, err := common.Marshal(request)
		require.NoError(t, err)
		require.Equal(t, string(before), string(after), "funding must preserve opaque client context")
		require.NoError(t, session.Settle(14))
		require.NoError(t, session.Settle(14))
		require.NoError(t, db.First(&team, team.ID).Error)
		require.EqualValues(t, -9, team.Balance)
		var ledger model.TeamFundingReservation
		require.NoError(t, db.First(&ledger, "request_id = ?", info.TeamReservationID).Error)
		assert.Equal(t, "team", ledger.Source)
		assert.Equal(t, "development", ledger.UsingGroup)
		assert.Equal(t, channel.Id, ledger.ChannelID)
		assert.Equal(t, channel.Name, ledger.ChannelName)
		assert.Equal(t, "development", info.UsingGroup, "fallback must retain selected group")

		require.False(t, session.NeedsRefund())
		info.RequestId += "-blocked"
		_, apiErr = newPolicyBillingSession(c, info, 1, policy)
		require.NotNil(t, apiErr)
		require.Equal(t, types.ErrorCodeInsufficientUserQuota, apiErr.GetErrorCode())
	}
}

func TestTeamMembershipRequiredEvenForPersonalWallet(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	previous := model.DB
	model.DB = db
	t.Cleanup(func() { model.DB = previous })
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Token{}, &model.Team{}, &model.TeamMember{}, &model.TeamKeyPolicy{}))
	user := model.User{Username: "unassigned", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Quota: 1000000}
	require.NoError(t, db.Create(&user).Error)
	token := model.Token{UserId: user.Id, Key: "membership-regression", Group: "default", UnlimitedQuota: true}
	require.NoError(t, db.Create(&token).Error)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/chat/completions", nil)
	require.Error(t, ValidateTeamTokenPolicy(c, token.Id, user.Id), "positive personal funds must not grant resource access without membership")
	groups, err := GetAccountUsableGroups(user.Id, "default")
	require.NoError(t, err)
	assert.Empty(t, groups)
	oldRatios := ratio_setting.GroupRatio2JSONString()
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1,"development":2,"testing":3}`))
	t.Cleanup(func() { require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(oldRatios)) })
	team := model.Team{Name: "Unified authority", Status: 1, AllowPersonalBackup: true, AllowedGroups: []string{"development", "testing"}, DefaultGroup: "development"}
	require.NoError(t, db.Create(&team).Error)
	membership := model.TeamMember{UserID: user.Id, TeamID: team.ID, Role: "member", Status: 1}
	require.NoError(t, db.Create(&membership).Error)
	groups, err = GetAccountUsableGroups(user.Id, "default")
	require.NoError(t, err)
	assert.Contains(t, groups, "development")
	assert.NotContains(t, groups, "default")
	require.NoError(t, db.Model(&token).Update("group", "").Error)
	for _, mode := range []string{"personal_only", "team_only", "personal_first", "team_first"} {
		require.NoError(t, model.SetTeamKeyPolicy(token.Id, user.Id, model.TeamKeyPolicy{Mode: mode, TeamID: team.ID}))
		require.NoError(t, ValidateTeamTokenPolicy(c, token.Id, user.Id))
		assert.Equal(t, "development", common.GetContextKeyString(c, constant.ContextKeyUsingGroup), mode)
		assert.Equal(t, "development", common.GetContextKeyString(c, constant.ContextKeyTokenGroup), "implicit group must remain team authorized during retries")
	}
	require.NoError(t, db.Model(&token).Update("group", "testing").Error)
	require.NoError(t, ValidateTeamTokenPolicy(c, token.Id, user.Id))
	assert.Equal(t, "testing", common.GetContextKeyString(c, constant.ContextKeyUsingGroup))
	common.SetContextKey(c, constant.ContextKeyTokenAutoGroups, []string{"default", "testing", "development"})
	assert.Equal(t, []string{"testing", "development"}, GetAccountAutoGroups(c, user.Id, "default"))
	encoded, err := common.Marshal([]string{"development"})
	require.NoError(t, err)
	require.NoError(t, db.Model(&team).Update("allowed_groups", string(encoded)).Error)
	require.Error(t, ValidateTeamTokenPolicy(c, token.Id, user.Id), "old selected-group key must stop after revoke")
	assert.Equal(t, []string{"development"}, GetAccountAutoGroups(c, user.Id, "default"))
	require.NoError(t, db.Model(&token).Update("group", "").Error)
	require.NoError(t, model.SetTeamKeyPolicy(token.Id, user.Id, model.TeamKeyPolicy{Mode: "personal_only"}))
	require.NoError(t, db.Model(&membership).Update("status", model.TeamMemberStatusRemoved).Error)
	require.Error(t, ValidateTeamTokenPolicy(c, token.Id, user.Id), "personal_only cannot escape removed membership")
	groups, err = GetAccountUsableGroups(user.Id, "default")
	require.NoError(t, err)
	assert.Empty(t, groups)
	assert.Empty(t, GetAccountAutoGroups(c, user.Id, "default"))

}
