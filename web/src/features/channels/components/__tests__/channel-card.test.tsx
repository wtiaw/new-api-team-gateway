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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { channelSchema, type Channel } from '../../types'
import { ChannelCard } from '../channel-card'
import { ChannelsProvider } from '../channels-provider'

function Fixture(props: { channel: Channel }) {
  const table = useReactTable({
    data: [props.channel],
    columns: [{ accessorKey: 'name', cell: (info) => info.getValue<string>() }],
    getCoreRowModel: getCoreRowModel(),
  })
  return <ChannelCard row={table.getRowModel().rows[0]} isSelected={false} />
}

function renderCard(setting?: string | null, aggregate = false) {
  const channel = channelSchema.parse({
    id: 1,
    type: 1,
    key: '',
    name: 'CPA',
    status: 1,
    created_time: 0,
    test_time: 0,
    response_time: 0,
    balance_updated_time: 0,
    setting,
  })
  const row = aggregate ? { ...channel, children: [channel] } : channel
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ChannelsProvider>
        <Fixture channel={row} />
      </ChannelsProvider>
    </QueryClientProvider>
  )
}

test.each([0.3, 0.5, 0.000001])(
  'shows the configured channel sales multiplier %sx beside its label',
  (multiplier) => {
    renderCard(JSON.stringify({ sales_multiplier: multiplier }))
    expect(screen.getByText('Channel Sales Multiplier')).toBeVisible()
    expect(screen.getByText(`${multiplier}x`)).toBeVisible()
  }
)

test.each([undefined, null, '{}', '{', 'null'])(
  'shows the effective default 1x when channel setting is %s',
  (setting) => {
    renderCard(setting)
    expect(screen.getByText('Channel Sales Multiplier')).toBeVisible()
    expect(screen.getByText('1x')).toBeVisible()
  }
)

test.each([undefined, '{"sales_multiplier":0.3}'])(
  'omits a concrete channel sales multiplier for tag aggregate setting %s',
  (setting) => {
    renderCard(setting, true)
    expect(
      screen.queryByText('Channel Sales Multiplier')
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/^(1|0\.3)x$/)).not.toBeInTheDocument()
  }
)
