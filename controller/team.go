package controller

import (
	"encoding/csv"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

func teamAPIResult(c *gin.Context, data any, err error, action string) {
	if err != nil {
		key := "Team operation failed"
		for _, known := range []error{model.ErrTeamAccess, model.ErrTeamInput, model.ErrTeamInvitation, model.ErrTeamOperation, model.ErrTeamGroupConflict, model.ErrTeamGroupRequired, model.ErrTeamPersonalBackupDisabled} {
			if errors.Is(err, known) {
				key = known.Error()
				break
			}
		}
		common.ApiErrorT(c, key)
		return
	}
	if action != "" {
		model.RecordAuditLog(c, model.AuditLog{UserId: c.GetInt("id"), ActorRole: c.GetInt("role"), Category: model.AuditCategoryOperation, Action: action, Content: action, Success: true})
	}
	common.ApiSuccess(c, data)
}
func teamIDParam(c *gin.Context, name string) (int, bool) {
	id, err := strconv.Atoi(c.Param(name))
	if err != nil || id <= 0 {
		common.ApiErrorT(c, "Invalid team settings")
		return 0, false
	}
	return id, true
}

// Members may see the team's spending ceilings, but not its wallet or other
// members' consumption. Keep this projection shared by list and detail APIs.
func teamPublicView(team model.Team, role string) gin.H {
	view := gin.H{
		"id": team.ID, "name": team.Name, "role": role, "status": team.Status,
		"daily_limit": team.DailyLimit, "weekly_limit": team.WeeklyLimit,
		"allow_personal_backup": team.AllowPersonalBackup,
		"allowed_groups":        team.AllowedGroups, "default_group": team.DefaultGroup,
		"created_at": team.CreatedAt, "updated_at": team.UpdatedAt,
	}
	if role != "member" {
		view["balance"] = team.Balance
	}
	return view
}

func ListTeams(c *gin.Context) {
	rows, err := model.ListTeams(c.GetInt("id"), c.GetInt("role"))
	if err != nil {
		teamAPIResult(c, nil, err, "")
		return
	}
	views := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		views = append(views, teamPublicView(row.Team, row.Role))
	}
	teamAPIResult(c, views, nil, "")
}
func CreateTeam(c *gin.Context) {
	var input model.TeamCreate
	if c.ShouldBindJSON(&input) != nil {
		common.ApiErrorT(c, "Invalid team settings")
		return
	}
	row, err := model.CreateTeam(c.GetInt("id"), c.GetInt("role"), input)
	teamAPIResult(c, row, err, "team.create")
}
func GetTeam(c *gin.Context) {
	id, ok := teamIDParam(c, "id")
	if !ok {
		return
	}
	team, role, err := model.GetTeam(id, c.GetInt("id"), c.GetInt("role"))
	if err != nil {
		teamAPIResult(c, nil, err, "")
		return
	}
	if role == "member" {
		teamAPIResult(c, gin.H{"team": teamPublicView(*team, role), "role": role}, nil, "")
		return
	}
	budget, err := model.GetTeamBudgetSummary(id, time.Now().Unix())
	teamAPIResult(c, gin.H{"team": teamPublicView(*team, role), "role": role, "budget": budget}, err, "")
}
func GetTeamOverview(c *gin.Context) {
	id, ok := teamIDParam(c, "id")
	if !ok {
		return
	}
	days, err := strconv.Atoi(c.DefaultQuery("days", "7"))
	if err != nil {
		teamAPIResult(c, nil, model.ErrTeamInput, "")
		return
	}
	memberID, err := strconv.Atoi(c.DefaultQuery("user_id", "0"))
	if err != nil || memberID < 0 {
		teamAPIResult(c, nil, model.ErrTeamInput, "")
		return
	}
	result, err := model.GetTeamOverviewForMember(id, c.GetInt("id"), c.GetInt("role"), days, time.Now().Unix(), memberID)
	teamAPIResult(c, result, err, "")
}
func UpdateTeam(c *gin.Context) {
	id, ok := teamIDParam(c, "id")
	if !ok {
		return
	}
	var input model.TeamUpdate
	if c.ShouldBindJSON(&input) != nil {
		common.ApiErrorT(c, "Invalid team settings")
		return
	}
	row, err := model.UpdateTeam(id, c.GetInt("id"), c.GetInt("role"), input)
	teamAPIResult(c, row, err, "team.update")
}
func AdjustTeamBalance(c *gin.Context) {
	id, ok := teamIDParam(c, "id")
	if !ok {
		return
	}
	var input struct {
		Mode        string `json:"mode"`
		Value       int64  `json:"value"`
		Reason      string `json:"reason"`
		OperationID string `json:"operation_id"`
	}
	if c.ShouldBindJSON(&input) != nil {
		common.ApiErrorT(c, "Invalid team settings")
		return
	}
	row, err := model.AdjustTeamBalance(id, c.GetInt("id"), c.GetInt("role"), input.Mode, input.Value, input.Reason, input.OperationID)
	teamAPIResult(c, row, err, "team.balance.adjust")
}
func ListTeamBalanceOperations(c *gin.Context) {
	id, ok := teamIDParam(c, "id")
	if !ok {
		return
	}
	rows, err := model.ListTeamBalanceOperations(id, c.GetInt("id"), c.GetInt("role"))
	teamAPIResult(c, rows, err, "")
}
func ListTeamMembers(c *gin.Context) {
	id, ok := teamIDParam(c, "id")
	if !ok {
		return
	}
	rows, err := model.ListTeamMembers(id, c.GetInt("id"), c.GetInt("role"))
	teamAPIResult(c, rows, err, "")
}
func UpdateTeamMember(c *gin.Context) {
	id, ok := teamIDParam(c, "id")
	if !ok {
		return
	}
	userID, ok := teamIDParam(c, "user_id")
	if !ok {
		return
	}
	var input struct {
		Role   *string `json:"role"`
		Status *int    `json:"status"`
	}
	if c.ShouldBindJSON(&input) != nil {
		common.ApiErrorT(c, "Invalid team settings")
		return
	}
	err := model.UpdateTeamMember(id, c.GetInt("id"), userID, c.GetInt("role"), input.Role, input.Status, false)
	teamAPIResult(c, nil, err, "team.member.update")
}
func DeleteTeamMember(c *gin.Context) {
	id, ok := teamIDParam(c, "id")
	if !ok {
		return
	}
	userID, ok := teamIDParam(c, "user_id")
	if !ok {
		return
	}
	err := model.UpdateTeamMember(id, c.GetInt("id"), userID, c.GetInt("role"), nil, nil, true)
	teamAPIResult(c, nil, err, "team.member.remove")
}
func ListTeamInvitations(c *gin.Context) {
	id, ok := teamIDParam(c, "id")
	if !ok {
		return
	}
	rows, err := model.ListTeamInvitations(id, c.GetInt("id"), c.GetInt("role"))
	teamAPIResult(c, rows, err, "")
}
func CreateTeamInvitation(c *gin.Context) {
	id, ok := teamIDParam(c, "id")
	if !ok {
		return
	}
	var input struct {
		ValidDays int `json:"valid_days"`
	}
	if c.ShouldBindJSON(&input) != nil {
		common.ApiErrorT(c, "Invalid team settings")
		return
	}
	row, token, err := model.CreateTeamInvitation(id, c.GetInt("id"), c.GetInt("role"), input.ValidDays)
	teamAPIResult(c, gin.H{"invitation": row, "token": token}, err, "team.invitation.create")
}
func RevokeTeamInvitation(c *gin.Context) {
	id, ok := teamIDParam(c, "id")
	if !ok {
		return
	}
	inviteID, ok := teamIDParam(c, "invite_id")
	if !ok {
		return
	}
	err := model.RevokeTeamInvitation(id, inviteID, c.GetInt("id"), c.GetInt("role"))
	teamAPIResult(c, nil, err, "team.invitation.revoke")
}
func PreviewTeamInvitation(c *gin.Context) {
	team, invite, state, err := model.PreviewTeamInvitation(c.Param("token"))
	if err != nil {
		teamAPIResult(c, nil, err, "")
		return
	}
	// Possession of an invitation reveals only landing-page metadata.
	teamAPIResult(c, gin.H{"team": gin.H{"id": team.ID, "name": team.Name}, "state": state, "expired_at": invite.ExpiresAt, "accepted_by_current_user": invite.AcceptedBy == c.GetInt("id") && invite.AcceptedBy > 0}, nil, "")
}
func AcceptTeamInvitation(c *gin.Context) {
	row, err := model.AcceptTeamInvitation(c.Param("token"), c.GetInt("id"))
	teamAPIResult(c, row, err, "team.invitation.accept")
}
func GetTeamKeyPolicy(c *gin.Context) {
	id, ok := teamIDParam(c, "token_id")
	if !ok {
		return
	}
	row, err := model.GetTeamKeyPolicy(id, c.GetInt("id"))
	teamAPIResult(c, row, err, "")
}
func SetTeamKeyPolicy(c *gin.Context) {
	id, ok := teamIDParam(c, "token_id")
	if !ok {
		return
	}
	var input model.TeamKeyPolicy
	if c.ShouldBindJSON(&input) != nil {
		common.ApiErrorT(c, "Invalid team settings")
		return
	}
	err := model.SetTeamKeyPolicy(id, c.GetInt("id"), input)
	teamAPIResult(c, nil, err, "team.key_policy.update")
}
func ListTeamUsage(c *gin.Context) {
	id, ok := teamIDParam(c, "id")
	if !ok {
		return
	}
	search := c.Query("search")
	if utf8.RuneCountInString(search) > 128 {
		common.ApiErrorT(c, "Invalid team settings")
		return
	}
	if !c.Request.URL.Query().Has("page") && !c.Request.URL.Query().Has("page_size") && !c.Request.URL.Query().Has("search") {
		rows, err := model.ListTeamUsage(id, c.GetInt("id"), c.GetInt("role"))
		teamAPIResult(c, rows, err, "")
		return
	}
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page < 1 {
		common.ApiErrorT(c, "Invalid team settings")
		return
	}
	size, err := strconv.Atoi(c.DefaultQuery("page_size", "100"))
	if err != nil || size < 1 || size > 500 || page-1 > math.MaxInt/size {
		common.ApiErrorT(c, "Invalid team settings")
		return
	}
	query, err := model.TeamUsageDisplayQuery(id, c.GetInt("id"), c.GetInt("role"), search)
	if err != nil {
		teamAPIResult(c, nil, err, "")
		return
	}
	query = query.WithContext(c.Request.Context())
	var total int64
	if err = query.Count(&total).Error; err != nil {
		teamAPIResult(c, nil, err, "")
		return
	}
	items := make([]model.TeamUsageRow, 0)
	err = query.Order("team_funding_reservations.created_at DESC, team_funding_reservations.request_id DESC").Offset((page - 1) * size).Limit(size).Find(&items).Error
	teamAPIResult(c, gin.H{"items": items, "total": total}, err, "")
}

func ExportTeamUsage(c *gin.Context) {
	id, ok := teamIDParam(c, "id")
	if !ok {
		return
	}
	search := c.Query("search")
	if utf8.RuneCountInString(search) > 128 {
		common.ApiErrorT(c, "Invalid team settings")
		return
	}
	query, err := model.TeamUsageDisplayQuery(id, c.GetInt("id"), c.GetInt("role"), search)
	if err != nil {
		teamAPIResult(c, nil, err, "")
		return
	}
	query = query.WithContext(c.Request.Context()).Order("team_funding_reservations.created_at DESC, team_funding_reservations.request_id DESC")
	rows, err := query.Rows()
	if err != nil {
		teamAPIResult(c, nil, err, "")
		return
	}
	defer rows.Close()
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", `attachment; filename="team-usage.csv"`)
	writer := csv.NewWriter(c.Writer)
	if err = writer.Write([]string{"time", "user_id", "model_name", "prompt_tokens", "completion_tokens", "actual", "state", "request_id", "username", "token_name", "token_id"}); err != nil {
		_ = c.Error(err)
		return
	}
	for rows.Next() {
		var row model.TeamUsageRow
		if err = query.ScanRows(rows, &row); err != nil {
			_ = c.Error(err)
			return
		}
		fields := []string{time.Unix(row.CreatedAt, 0).UTC().Format(time.RFC3339), strconv.Itoa(row.UserID), row.ModelName, strconv.Itoa(row.PromptTokens), strconv.Itoa(row.CompletionTokens), strconv.FormatInt(row.Actual, 10), row.State, row.RequestID, row.Username, row.TokenName, strconv.Itoa(row.TokenID)}
		// Prevent untrusted text fields from becoming spreadsheet formulas on export.
		for _, i := range []int{2, 6, 7, 8, 9} {
			text := strings.TrimLeft(fields[i], " \t\r\n")
			if len(text) > 0 && strings.ContainsRune("=+-@", rune(text[0])) {
				fields[i] = "'" + fields[i]
			}
		}
		if err = writer.Write(fields); err != nil {
			_ = c.Error(err)
			return
		}
		writer.Flush()
		if err = writer.Error(); err != nil {
			_ = c.Error(err)
			return
		}
	}
	if err = rows.Err(); err != nil {
		_ = c.Error(err)
		return
	}
	writer.Flush()
	if err = writer.Error(); err != nil {
		_ = c.Error(err)
	}
}
