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
// Team management APIs use New API's fixed internal quota unit per USD.
export const TEAM_QUOTA_PER_USD = 500000
export function usdToQuota(value: string): number | null {
  if (!value.trim()) return null
  const amount = Number(value)
  const quota = Math.round(amount * TEAM_QUOTA_PER_USD)
  if (
    !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) ||
    !Number.isSafeInteger(quota) ||
    amount < 0
  ) {
    throw new Error('Enter a valid non-negative USD amount')
  }
  return quota
}
