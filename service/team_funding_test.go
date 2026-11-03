package service

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
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
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Team{}, &model.TeamMember{}, &model.TeamFundingReservation{}))
	user := model.User{Username: "postpaid-system", Role: common.RoleAdminUser, Status: common.UserStatusEnabled}
	require.NoError(t, db.Create(&user).Error)
	team := model.Team{Name: "Postpaid", Status: 1, Balance: 5, DailyLimit: new(int64(5)), WeeklyLimit: new(int64(5))}
	require.NoError(t, db.Create(&team).Error)
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
		info := &relaycommon.RelayInfo{RequestId: fmt.Sprintf("codex-%d", i), UserId: user.Id, IsPlayground: true, Request: request}
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body))
		policy := &model.TeamKeyPolicy{Mode: "team_only", TeamID: team.ID, UserID: user.Id}
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
		require.False(t, session.NeedsRefund())
		info.RequestId += "-blocked"
		_, apiErr = newPolicyBillingSession(c, info, 1, policy)
		require.NotNil(t, apiErr)
		require.Equal(t, types.ErrorCodeInsufficientUserQuota, apiErr.GetErrorCode())
	}
}
