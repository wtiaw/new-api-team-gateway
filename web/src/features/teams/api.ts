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
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

export async function teamGet<T>(path: string): Promise<T> {
  const response = await api.get<{ success: boolean; data: T }>(path)
  return requireServerSuccess(response.data).data
}
export async function teamWrite<T = unknown>(
  method: 'post' | 'put' | 'delete',
  path: string,
  body?: unknown
): Promise<T> {
  const response = await api[method]<{ success: boolean; data: T }>(path, body)
  return requireServerSuccess(response.data).data
}
export function useTeamMutation(onSuccess?: () => void) {
  const client = useQueryClient()
  const { t } = useTranslation()
  return useMutation({
    mutationFn: (request: {
      method: 'post' | 'put' | 'delete'
      path: string
      body?: unknown
    }) => teamWrite(request.method, request.path, request.body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['teams'] })
      toast.success(t('Changes saved'))
      onSuccess?.()
    },
  })
}
