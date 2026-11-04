package service

import (
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
)

func GetUserUsableGroups(userGroup string) map[string]string {
	groupsCopy := setting.GetUserUsableGroupsCopy()
	if userGroup != "" {
		specialSettings, b := ratio_setting.GetGroupRatioSetting().GroupSpecialUsableGroup.Get(userGroup)
		if b {
			// 处理特殊可用分组
			for specialGroup, desc := range specialSettings {
				if after, ok := strings.CutPrefix(specialGroup, "-:"); ok {
					// 移除分组
					groupToRemove := after
					delete(groupsCopy, groupToRemove)
				} else if after, ok := strings.CutPrefix(specialGroup, "+:"); ok {
					// 添加分组
					groupToAdd := after
					groupsCopy[groupToAdd] = desc
				} else {
					// 直接添加分组
					groupsCopy[specialGroup] = desc
				}
			}
		}
		// 如果userGroup不在UserUsableGroups中，返回UserUsableGroups + userGroup。
		// 描述是英文源文本，由 web 控制台翻译；管理员配置的描述原样显示。
		if _, ok := groupsCopy[userGroup]; !ok {
			groupsCopy[userGroup] = "User group"
		}
	}
	return groupsCopy
}

func GroupInUserUsableGroups(userGroup, groupName string) bool {
	_, ok := GetUserUsableGroups(userGroup)[groupName]
	return ok
}

func IsUserSelectableGroup(userGroup, groupName string) bool {
	if groupName == "" || groupName == "auto" {
		return false
	}
	return GroupInUserUsableGroups(userGroup, groupName) && ratio_setting.ContainsGroupRatio(groupName)
}

// GetUserAutoGroup 根据用户分组获取自动分组设置
func GetUserAutoGroup(userGroup string) []string {
	autoGroups := make([]string, 0)
	seen := make(map[string]struct{})
	for _, group := range setting.GetAutoGroups() {
		if !IsUserSelectableGroup(userGroup, group) {
			continue
		}
		if _, ok := seen[group]; ok {
			continue
		}
		seen[group] = struct{}{}
		autoGroups = append(autoGroups, group)
	}
	return autoGroups
}

// FilterUserTokenAutoGroups applies current permissions before the current
// per-token limit. It intentionally does not fall back to the global Auto list.
func FilterUserTokenAutoGroups(userGroup string, groups []string) []string {
	maxCount := setting.GetMaxTokenAutoGroups()
	filtered := make([]string, 0, min(len(groups), maxCount))
	seen := make(map[string]struct{})
	for _, group := range groups {
		if !IsUserSelectableGroup(userGroup, group) {
			continue
		}
		if _, ok := seen[group]; ok {
			continue
		}
		seen[group] = struct{}{}
		filtered = append(filtered, group)
		if len(filtered) == maxCount {
			break
		}
	}
	return filtered
}

// GetRequestAutoGroups resolves the ordered Auto groups for the current token.
// The absence of the context value means that the token inherits the complete
// global Auto list; a present (even empty) value is an explicit token snapshot.
func GetRequestAutoGroups(c *gin.Context, userGroup string) []string {
	if userID := c.GetInt("id"); userID > 0 {
		return GetAccountAutoGroups(c, userID, userGroup)
	}
	value, ok := common.GetContextKey(c, constant.ContextKeyTokenAutoGroups)
	if !ok {
		return GetUserAutoGroup(userGroup)
	}
	groups, ok := value.([]string)
	if !ok {
		return []string{}
	}
	return FilterUserTokenAutoGroups(userGroup, groups)
}

// GetGroupsEnabledModels 按 groups 顺序获取各分组启用的模型并去重
func GetGroupsEnabledModels(groups []string) []string {
	seen := make(map[string]struct{})
	models := make([]string, 0)
	for _, group := range groups {
		for _, modelName := range model.GetGroupEnabledModels(group) {
			if _, ok := seen[modelName]; !ok {
				seen[modelName] = struct{}{}
				models = append(models, modelName)
			}
		}
	}
	return models
}

// GetUserGroupRatio 获取用户使用某个分组的倍率
// userGroup 用户分组
// group 需要获取倍率的分组
func GetUserGroupRatio(userGroup, group string) float64 {
	ratio, ok := ratio_setting.GetGroupGroupRatio(userGroup, group)
	if ok {
		return ratio
	}
	return ratio_setting.GetGroupRatio(group)
}

// GetAccountUsableGroups is the resource authority for both funding sources.
func GetAccountUsableGroups(userID int, userGroup string) (map[string]string, error) {
	team, native, err := model.ActiveTeamGroupProfile(userID, 0)
	if err != nil {
		return nil, err
	}
	if native {
		return GetUserUsableGroups(userGroup), nil
	}
	groups := make(map[string]string)
	if team != nil {
		for _, group := range team.AllowedGroups {
			if group != "" && group != "auto" && ratio_setting.ContainsGroupRatio(group) {
				groups[group] = setting.GetUsableGroupDescription(group)
			}
		}
	}
	return groups, nil
}

// ResolveAccountGroup prevents native defaults and saved keys from escaping team grants.
func ResolveAccountGroup(userID, teamID int, userGroup, requested string) (string, error) {
	team, native, err := model.ActiveTeamGroupProfile(userID, teamID)
	if err != nil {
		return "", err
	}
	if native {
		if requested == "" {
			requested = userGroup
		}
		if requested == "auto" || IsUserSelectableGroup(userGroup, requested) {
			return requested, nil
		}
		return "", model.ErrTeamAccess
	}
	if team == nil {
		return "", model.ErrTeamAccess
	}
	groups := make([]string, 0, len(team.AllowedGroups))
	for _, group := range team.AllowedGroups {
		if group != "" && group != "auto" && ratio_setting.ContainsGroupRatio(group) {
			groups = append(groups, group)
		}
	}
	if len(groups) == 0 {
		return "", model.ErrTeamAccess
	}
	if requested == "auto" {
		return requested, nil
	}
	if requested == "" {
		requested = team.DefaultGroup
		if requested == "" && len(groups) == 1 {
			requested = groups[0]
		}
	}
	for _, group := range groups {
		if group == requested {
			return requested, nil
		}
	}
	return "", model.ErrTeamAccess
}

func GetAccountAutoGroups(c *gin.Context, userID int, userGroup string) []string {
	team, native, err := model.ActiveTeamGroupProfile(userID, c.GetInt("resource_team_id"))
	if err != nil {
		return []string{}
	}
	if native {
		value, ok := common.GetContextKey(c, constant.ContextKeyTokenAutoGroups)
		if !ok {
			return GetUserAutoGroup(userGroup)
		}
		groups, _ := value.([]string)
		return FilterUserTokenAutoGroups(userGroup, groups)
	}
	if team == nil {
		return []string{}
	}
	candidates := team.AllowedGroups
	value, explicit := common.GetContextKey(c, constant.ContextKeyTokenAutoGroups)
	if explicit {
		candidates, _ = value.([]string)
	}
	result := make([]string, 0, len(candidates))
	seen := make(map[string]bool)
	for _, group := range candidates {
		if seen[group] || group == "" || group == "auto" || !ratio_setting.ContainsGroupRatio(group) {
			continue
		}
		for _, allowed := range team.AllowedGroups {
			if allowed == group {
				result = append(result, group)
				seen[group] = true
				break
			}
		}
		if explicit && len(result) >= setting.GetMaxTokenAutoGroups() {
			break
		}
	}
	return result
}
