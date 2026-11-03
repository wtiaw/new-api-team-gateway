import type { TeamUsageDay } from './types'

export type TeamTrendMetric = 'requests' | 'actual' | 'tokens'
export interface TeamTrendSeries {
  key: string
  trend: TeamUsageDay[]
}

// Join on persisted Shanghai calendar days, never the position of an API row.
export function buildTeamTrendRows(
  series: TeamTrendSeries[],
  metric: TeamTrendMetric,
  days: number
) {
  const starts = [
    ...new Set(
      series.flatMap((item) => item.trend.map((day) => day.day_start))
    ),
  ]
    .sort((a, b) => a - b)
    .slice(-days)
  const indexes = series.map(
    (item) => new Map(item.trend.map((day) => [day.day_start, day]))
  )
  return starts.map((day_start) => {
    const row: Record<string, number> = { day_start }
    series.forEach((item, index) => {
      const day = indexes[index].get(day_start)
      let value = 0
      if (day) {
        value =
          metric === 'tokens'
            ? day.prompt_tokens + day.completion_tokens
            : day[metric]
      }
      row[item.key] = value
    })
    return row
  })
}
