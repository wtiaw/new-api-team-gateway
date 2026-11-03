import { expect, test } from 'vitest'

import { buildTeamTrendRows } from '../team-trend-data'
import type { TeamUsageDay } from '../types'

const day = (
  day_start: number,
  requests: number,
  actual: number,
  prompt_tokens: number,
  completion_tokens: number
) =>
  ({
    day_start,
    requests,
    actual,
    prompt_tokens,
    completion_tokens,
  }) as TeamUsageDay
const series = [
  { key: 'member_3', trend: [day(10, 2, 14, 12, 8), day(20, 1, 7, 2, 3)] },
  { key: 'member_4', trend: [day(20, 4, 50, 100, 25), day(30, 1, 9, 8, 2)] },
]
test('compared members align by calendar day without mixing request counts', () => {
  expect(buildTeamTrendRows(series, 'requests', 7)).toEqual([
    { day_start: 10, member_3: 2, member_4: 0 },
    { day_start: 20, member_3: 1, member_4: 4 },
    { day_start: 30, member_3: 0, member_4: 1 },
  ])
})
test('cost and tokens retain independent series and clamp the visible date count', () => {
  expect(buildTeamTrendRows(series, 'actual', 2)).toEqual([
    { day_start: 20, member_3: 7, member_4: 50 },
    { day_start: 30, member_3: 0, member_4: 9 },
  ])
  expect(buildTeamTrendRows(series, 'tokens', 7)[1]).toEqual({
    day_start: 20,
    member_3: 5,
    member_4: 125,
  })
})
