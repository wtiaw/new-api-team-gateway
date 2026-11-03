package model

import (
	"cmp"
	"slices"
)

// Overview usage is read from the primary funding ledger, independent of the
// optional log database. Only settled requests contribute spend and tokens.
type TeamUsageMetrics struct {
	Requests         int64 `json:"requests"`
	SettledRequests  int64 `json:"settled_requests"`
	ReservedRequests int64 `json:"reserved_requests"`
	RefundedRequests int64 `json:"refunded_requests"`
	Actual           int64 `json:"actual"`
	Reserved         int64 `json:"reserved"`
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
}

func (m *TeamUsageMetrics) add(other TeamUsageMetrics) {
	m.Requests += other.Requests
	m.SettledRequests += other.SettledRequests
	m.ReservedRequests += other.ReservedRequests
	m.RefundedRequests += other.RefundedRequests
	m.Actual += other.Actual
	m.Reserved += other.Reserved
	m.PromptTokens += other.PromptTokens
	m.CompletionTokens += other.CompletionTokens
}

type TeamUsageDay struct {
	TeamUsageMetrics
	DayStart int64 `json:"day_start"`
}

type TeamUsageModel struct {
	TeamUsageMetrics
	ModelName string `json:"model_name"`
}

type TeamOverviewMember struct {
	UserID   int    `json:"user_id"`
	Username string `json:"username"`
}

type TeamOverview struct {
	MemberID    int                  `json:"member_id,omitempty"`
	Members     []TeamOverviewMember `json:"members,omitempty"`
	Scope       string               `json:"scope"`
	StartTime   int64                `json:"start_time"`
	EndTime     int64                `json:"end_time"`
	Days        int                  `json:"days"`
	Summary     TeamUsageMetrics     `json:"summary"`
	Trend       []TeamUsageDay       `json:"trend"`
	Models      []TeamUsageModel     `json:"models"`
	PeriodUsage TeamBudgetSummary    `json:"period_usage"`
}

func GetTeamOverview(teamID, actorID, globalRole, days int, now int64) (*TeamOverview, error) {
	return GetTeamOverviewForMember(teamID, actorID, globalRole, days, now, 0)
}

func GetTeamOverviewForMember(teamID, actorID, globalRole, days int, now int64, memberID int) (*TeamOverview, error) {
	if (days != 7 && days != 30) || memberID < 0 {
		return nil, ErrTeamInput
	}
	_, role, err := GetTeam(teamID, actorID, globalRole)
	if err != nil {
		return nil, err
	}
	query, err := TeamUsageQuery(teamID, actorID, globalRole, "")
	if err != nil {
		return nil, err
	}
	var members []TeamOverviewMember
	if role == "member" {
		if memberID != 0 && memberID != actorID {
			return nil, ErrTeamAccess
		}
	} else {
		// Current members and all historical spenders remain selectable. Do not
		// widen a normal member's query or expose other members through this list.
		current := DB.Model(&TeamMember{}).Select("user_id").Where("team_id = ? AND status <> ?", teamID, TeamMemberStatusRemoved)
		history := DB.Model(&TeamFundingReservation{}).Select("user_id").Where("team_id = ?", teamID)
		err = DB.Table("users").Select("users.id AS user_id, users.username").
			Where("users.id IN (?) OR users.id IN (?)", current, history).
			Order("users.username ASC, users.id ASC").Scan(&members).Error
		if err != nil {
			return nil, err
		}
		if memberID > 0 && !slices.ContainsFunc(members, func(member TeamOverviewMember) bool { return member.UserID == memberID }) {
			return nil, ErrTeamAccess
		}
	}
	if memberID > 0 {
		query = query.Where("team_funding_reservations.user_id = ?", memberID)
	}
	day, week := teamPeriodStarts(now)
	start := day - int64(days-1)*86400
	var rows []struct {
		TeamUsageMetrics
		DayStart  int64
		ModelName string
	}
	// Group by the persisted original request period: late settlement/refund
	// belongs to the request's original day, just like team budget accounting.
	err = query.Where("created_at >= ? AND created_at <= ?", start, now).
		Select(`day_start, model_name, COUNT(*) AS requests,
			SUM(CASE WHEN state = 'settled' THEN 1 ELSE 0 END) AS settled_requests,
			SUM(CASE WHEN state = 'reserved' THEN 1 ELSE 0 END) AS reserved_requests,
			SUM(CASE WHEN state = 'refunded' THEN 1 ELSE 0 END) AS refunded_requests,
			SUM(CASE WHEN state = 'settled' THEN actual ELSE 0 END) AS actual,
			SUM(CASE WHEN state = 'reserved' THEN reserved ELSE 0 END) AS reserved,
			SUM(CASE WHEN state = 'settled' THEN prompt_tokens ELSE 0 END) AS prompt_tokens,
			SUM(CASE WHEN state = 'settled' THEN completion_tokens ELSE 0 END) AS completion_tokens`).
		Group("day_start, model_name").Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	result := &TeamOverview{Scope: "team", MemberID: memberID, Members: members, StartTime: start, EndTime: now, Days: days,
		Trend: make([]TeamUsageDay, days), Models: make([]TeamUsageModel, 0),
		PeriodUsage: TeamBudgetSummary{DayStart: day, WeekStart: week}}
	if role == "member" {
		result.Scope = "mine"
	} else if memberID > 0 {
		result.Scope = "member"
	}
	for i := range days {
		result.Trend[i].DayStart = start + int64(i)*86400
	}
	models := make(map[string]TeamUsageMetrics)
	for _, row := range rows {
		result.Summary.add(row.TeamUsageMetrics)
		// Reuse the authorized ledger rows; a member's query contains only their
		// own team-funded requests. Calendar periods never follow the chart range.
		if row.DayStart == day {
			result.PeriodUsage.DailyUsed += row.Actual
			result.PeriodUsage.DailyReserved += row.Reserved
		}
		if row.DayStart >= week && row.DayStart <= day {
			result.PeriodUsage.WeeklyUsed += row.Actual
			result.PeriodUsage.WeeklyReserved += row.Reserved
		}
		index := (row.DayStart - start) / 86400
		if index >= 0 && index < int64(days) {
			result.Trend[index].TeamUsageMetrics.add(row.TeamUsageMetrics)
		}
		total := models[row.ModelName]
		total.add(row.TeamUsageMetrics)
		models[row.ModelName] = total
	}
	for name, total := range models {
		result.Models = append(result.Models, TeamUsageModel{TeamUsageMetrics: total, ModelName: name})
	}
	slices.SortFunc(result.Models, func(a, b TeamUsageModel) int {
		if order := cmp.Compare(b.Actual, a.Actual); order != 0 {
			return order
		}
		if order := cmp.Compare(b.Requests, a.Requests); order != 0 {
			return order
		}
		return cmp.Compare(a.ModelName, b.ModelName)
	})
	return result, nil
}
