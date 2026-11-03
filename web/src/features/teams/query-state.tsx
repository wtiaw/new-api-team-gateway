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
import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { getServerErrorMessage } from '@/lib/server-error-message'

export function TeamQueryState<T>(props: {
  query: UseQueryResult<T>
  children: (data: T) => ReactNode
}) {
  if (props.query.isPending) return <LoadingState />
  if (props.query.isError) {
    return (
      <ErrorState
        description={getServerErrorMessage(props.query.error)}
        onRetry={() => void props.query.refetch()}
      />
    )
  }
  return props.children(props.query.data)
}
