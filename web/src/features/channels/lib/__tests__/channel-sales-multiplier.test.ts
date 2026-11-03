import { expect, test } from 'vitest'

import zhTW from '@/i18n/locales/zh-TW.json'
import zh from '@/i18n/locales/zh.json'

import type { Channel } from '../../types'
import {
  buildSettingJSON,
  CHANNEL_FORM_DEFAULT_VALUES,
  channelFormSchema,
  transformChannelToFormDefaults,
} from '../channel-form'

test('legacy channels default to 1x and discounts survive an edit', () => {
  const channel = {
    type: 1,
    setting: '{}',
    channel_info: { multi_key_mode: 'random' },
  } as Channel
  expect(transformChannelToFormDefaults(channel).sales_multiplier).toBe(1)
  channel.setting = '{"sales_multiplier":0.3}'
  expect(transformChannelToFormDefaults(channel).sales_multiplier).toBe(0.3)
  expect(
    JSON.parse(
      buildSettingJSON({
        ...CHANNEL_FORM_DEFAULT_VALUES,
        sales_multiplier: 0.5,
      })
    ).sales_multiplier
  ).toBe(0.5)
})
test.each([0, -1, 101, Infinity, Number.NaN])(
  'rejects invalid sale multiplier %s',
  (sales_multiplier) => {
    const result = channelFormSchema.safeParse({
      ...CHANNEL_FORM_DEFAULT_VALUES,
      name: 'test',
      key: 'key',
      models: 'test',
      sales_multiplier,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path[0] === 'sales_multiplier'
        )
      ).toBe(true)
    }
  }
)

test('Chinese sale multiplier labels live in the runtime translation namespace', () => {
  expect(zh.translation['Channel Sales Multiplier']).toBe('渠道销售倍率')
  expect(zhTW.translation['Channel Sales Multiplier']).toBe('渠道銷售倍率')
})
