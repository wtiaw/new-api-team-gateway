import { FundingPolicyDialog } from '@/features/teams/funding-policy-dialog'

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
import { ApiKeysDeleteDialog } from './api-keys-delete-dialog'
import { ApiKeysMutateDrawer } from './api-keys-mutate-drawer'
import { useApiKeys } from './api-keys-provider'
import { ClientImportDialog } from './dialogs/client-import-dialog'

export function ApiKeysDialogs() {
  const { open, setOpen, currentRow } = useApiKeys()

  return (
    <>
      {currentRow && open === 'funding-policy' && (
        <FundingPolicyDialog
          tokenId={currentRow.id}
          open
          onOpenChange={(isOpen) => !isOpen && setOpen(null)}
        />
      )}
      <ApiKeysMutateDrawer
        open={open === 'create' || open === 'update'}
        onOpenChange={(isOpen) => !isOpen && setOpen(null)}
        currentRow={open === 'update' ? currentRow || undefined : undefined}
      />
      <ApiKeysDeleteDialog />
      {currentRow && (open === 'cc-switch' || open === 'magpie') && (
        <ClientImportDialog
          key={`${open}-${currentRow.id}`}
          client={open}
          apiKey={currentRow}
          open
          onOpenChange={(isOpen) => !isOpen && setOpen(null)}
        />
      )}
    </>
  )
}
