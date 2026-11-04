/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
export type TeamRole = 'admin' | 'member' | 'system'
export interface TeamUsageMetrics {
  requests: number
  settled_requests: number
  reserved_requests: number
  refunded_requests: number
  actual: number
  reserved: number
  prompt_tokens: number
  completion_tokens: number
}
export interface TeamUsageDay extends TeamUsageMetrics {
  day_start: number
}
export interface TeamUsageModel extends TeamUsageMetrics {
  model_name: string
}
export interface TeamOverviewData {
  scope: 'team' | 'mine' | 'member'
  member_id?: number
  members?: { user_id: number; username: string }[]
  start_time: number
  end_time: number
  days: number
  summary: TeamUsageMetrics
  trend: TeamUsageDay[]
  models: TeamUsageModel[]
  period_usage?: TeamDetail['budget']
}
export interface Team {
  id: number
  name: string
  role: TeamRole
  status: number
  balance?: number
  daily_limit: number | null
  weekly_limit: number | null
  allow_personal_backup?: boolean
  allowed_groups?: string[]
  default_group?: string
}
export interface TeamDetail {
  team: Team
  role: TeamRole
  budget?: {
    daily_used: number
    daily_reserved: number
    weekly_used: number
    weekly_reserved: number
    day_start: number
    week_start: number
  } | null
}
export interface TeamMember {
  id: number
  user_id: number
  username: string
  display_name: string
  role: 'admin' | 'member'
  status: number
}
export interface TeamInvitation {
  accepted_username?: string
  id: number
  expired_at: number
  revoked_at: number
  used_by: number
  used_at: number
  created_at: number
}
export interface TeamUsage {
  using_group?: string
  channel_id?: number
  channel_name?: string
  username?: string
  token_name?: string
  request_id: string
  user_id: number
  token_id: number
  source: string
  model_name: string
  reserved: number
  actual: number
  state: string
  created_at: number
  prompt_tokens: number
  completion_tokens: number
  fallback_reason: string
}
export interface QuotaOperation {
  id: number
  mode: string
  value: number
  balance_before: number
  balance_after: number
  reason: string
  created_at: number
  actor_id: number
}
export type FundingMode =
  | 'legacy'
  | 'personal_only'
  | 'team_only'
  | 'team_first'
  | 'personal_first'
export interface FundingPolicy {
  mode: FundingMode
  team_id: number
  team_name?: string
  resource_group?: string
  resolution_error?: string
}
