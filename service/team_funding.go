package service

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
)

const BillingSourceTeam = "team"

func TeamPolicyClientMessage(c *gin.Context, err error) string {
	if errors.Is(err, model.ErrTeamGroupRequired) {
		return i18n.T(c, i18n.MsgTeamGroupRequired)
	}
	if errors.Is(err, model.ErrTeamGroupConflict) {
		return i18n.T(c, i18n.MsgTeamGroupConflict)
	}
	return err.Error()
}

func TeamPolicyFromContext(c *gin.Context) *model.TeamKeyPolicy {
	if c == nil {
		return nil
	}
	value, ok := c.Get("team_key_policy")
	if !ok {
		return nil
	}
	policy, _ := value.(*model.TeamKeyPolicy)
	return policy
}

// ValidateTeamTokenPolicy runs even for free models and legacy relay paths.
func ValidateTeamTokenPolicy(c *gin.Context, tokenID, userID int) error {
	policy, err := model.GetTeamKeyPolicy(tokenID, userID)
	if err != nil {
		return err
	}
	var token model.Token
	if err := model.DB.Where("id = ? AND user_id = ?", tokenID, userID).First(&token).Error; err != nil {
		return err
	}
	group, team, err := resolveAccountResource(userID, policy.TeamID, common.GetContextKeyString(c, constant.ContextKeyUserGroup), token.Group)
	if err != nil {
		return err
	}
	policy.TeamID = 0
	if team != nil {
		policy.TeamID = team.ID
	}
	c.Set("resource_team_id", policy.TeamID)
	common.SetContextKey(c, constant.ContextKeyUsingGroup, group)
	common.SetContextKey(c, constant.ContextKeyTokenGroup, group)
	return validateTeamFundingPolicy(c, policy)
}

// Playground requests have a login session rather than a stored API key.
// Resolve the account default, then enforce the same team funding checks.
func ValidatePlaygroundTeamPolicy(c *gin.Context, userID int) error {
	requested := common.GetContextKeyString(c, constant.ContextKeyUsingGroup)
	policy, err := model.DefaultTeamKeyPolicyForGroup(userID, requested)
	if err != nil {
		return err
	}
	group, team, err := resolveAccountResource(userID, policy.TeamID, common.GetContextKeyString(c, constant.ContextKeyUserGroup), requested)
	if err != nil {
		return err
	}
	policy.TeamID = 0
	if team != nil {
		policy.TeamID = team.ID
	}
	c.Set("resource_team_id", policy.TeamID)
	common.SetContextKey(c, constant.ContextKeyUsingGroup, group)
	common.SetContextKey(c, constant.ContextKeyTokenGroup, group)
	return validateTeamFundingPolicy(c, policy)
}

func validateTeamFundingPolicy(c *gin.Context, policy *model.TeamKeyPolicy) error {
	if policy.Mode == "legacy" {
		return nil
	}
	if policy.Mode != "personal_only" {
		role, err := model.TeamFundingPolicyUserRole(policy.UserID)
		if err != nil {
			return err
		}
		if err := model.RequireTeamAccess(policy.TeamID, policy.UserID, role, false); err != nil {
			return err
		}
		var team model.Team
		if err := model.DB.First(&team, policy.TeamID).Error; err != nil {
			return err
		}
		if team.Status != 1 {
			return model.ErrTeamFundingForbidden
		}
		if (policy.Mode == "team_first" || policy.Mode == "personal_first") && !team.AllowPersonalBackup {
			return model.ErrTeamPersonalBackupDisabled
		}
		if strings.HasPrefix(c.Request.URL.Path, "/mj") || strings.Contains(c.Request.URL.Path, "/realtime") {
			return errors.New("This legacy protocol does not support team funding")
		}
	}
	c.Set("team_key_policy", policy)
	return nil
}

type TeamFunding struct {
	info   *relaycommon.RelayInfo
	teamID int
}

func (f *TeamFunding) Source() string { return BillingSourceTeam }
func (f *TeamFunding) PreConsume(amount int) error {
	if amount != 0 {
		return model.ErrTeamFundingState
	}
	record, err := model.ReservePostpaidTeamFunding(f.info.RequestId, f.teamID, f.info.UserId, f.info.TokenId, f.info.GetBillingModelName(), common.GetTimestamp())
	if err != nil {
		return err
	}
	f.info.TeamID, f.info.TeamReservationID = f.teamID, record.RequestID
	if err := f.recordRoute(); err != nil {
		common.SysError("record team funding route: " + err.Error())
	}

	return nil
}
func (f *TeamFunding) Settle(delta int) error {
	if err := f.recordRoute(); err != nil {
		common.SysError("record team funding route: " + err.Error())
	}
	if err := model.SettleTeamFunding(f.info.TeamReservationID, int64(delta)); err != nil {
		return err
	}
	if !f.info.ForcePreConsume {
		return model.CloseTeamFundingRefundWindow(f.info.TeamReservationID)
	}
	return nil
}
func (f *TeamFunding) Refund() error { return model.RefundTeamFunding(f.info.TeamReservationID) }

func newPolicyBillingSession(c *gin.Context, info *relaycommon.RelayInfo, quota int, policy *model.TeamKeyPolicy) (*BillingSession, *types.NewAPIError) {
	apiError := func(err error) *types.NewAPIError {
		return types.NewErrorWithStatusCode(err, types.ErrorCodeInvalidRequest, http.StatusForbidden, types.ErrOptionWithSkipRetry(), types.ErrOptionWithNoRecordErrorLog())
	}
	info.FundingPolicy = policy.Mode
	if policy.Mode != "personal_only" {
		role, err := model.TeamFundingPolicyUserRole(info.UserId)
		if err != nil {
			return nil, apiError(err)
		}
		if err := model.RequireTeamAccess(policy.TeamID, info.UserId, role, false); err != nil {
			return nil, apiError(err)
		}
		var team model.Team
		if err := model.DB.First(&team, policy.TeamID).Error; err != nil {
			return nil, apiError(err)
		}
		if team.Status != 1 {
			return nil, apiError(model.ErrTeamFundingForbidden)
		}
	}
	tryWallet := func() (*BillingSession, *types.NewAPIError) {
		if policy.Mode != "personal_only" {
			var team model.Team
			if err := model.DB.First(&team, policy.TeamID).Error; err != nil {
				return nil, apiError(err)
			}
			if !team.AllowPersonalBackup {
				return nil, apiError(model.ErrTeamPersonalBackupDisabled)
			}
		}
		userQuota, err := model.GetUserQuota(info.UserId, false)
		if err != nil {
			return nil, apiError(err)
		}
		info.UserQuota = userQuota
		info.TeamID, info.TeamReservationID = 0, ""
		session := &BillingSession{relayInfo: info, funding: &WalletFunding{userId: info.UserId}}
		errAPI := session.preConsume(c, quota)
		return session, errAPI
	}
	tryTeam := func() (*BillingSession, *types.NewAPIError) {
		info.TeamID = policy.TeamID
		session := &BillingSession{relayInfo: info, funding: &TeamFunding{info: info, teamID: policy.TeamID}}
		errAPI := session.preConsume(c, 0)
		if errAPI == nil {
			c.Set("team_reservation_id", info.TeamReservationID)
		}
		return session, errAPI
	}
	switch policy.Mode {
	case "personal_only":
		return tryWallet()
	case "team_only":
		return tryTeam()
	case "team_first":
		session, err := tryTeam()
		if err != nil && err.GetErrorCode() == types.ErrorCodeInsufficientUserQuota {
			info.FundingFallbackReason = err.Error()
			return tryWallet()
		}
		return session, err
	case "personal_first":
		session, err := tryWallet()
		if err != nil && err.GetErrorCode() == types.ErrorCodeInsufficientUserQuota {
			info.FundingFallbackReason = "Personal balance is insufficient"
			return tryTeam()
		}
		return session, err
	default:
		return nil, apiError(fmt.Errorf("Unknown team funding policy"))
	}
}

func (f *TeamFunding) recordRoute() error {
	name := ""
	channelID := 0
	if f.info.ChannelMeta != nil {
		channelID = f.info.ChannelId
	}
	if channelID > 0 {
		channel, err := model.CacheGetChannel(channelID)
		if err == nil && channel != nil {
			name = channel.Name
		}
	}
	return model.RecordTeamFundingRoute(f.info.TeamReservationID, f.info.UsingGroup, channelID, name)
}
