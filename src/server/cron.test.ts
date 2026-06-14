import { describe, expect, it } from 'vitest'
import { cronMatches, isValidCron, nextDescription, parseCron } from './cron.ts'

// Build a local-time Date for given fields (month is 1-based here for clarity).
function at(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0)
}

describe('parseCron', () => {
  it('rejects wrong field counts', () => {
    expect(() => parseCron('* * * *')).toThrow()
    expect(() => parseCron('* * * * * *')).toThrow()
  })

  it('rejects out-of-range values', () => {
    expect(() => parseCron('60 * * * *')).toThrow()
    expect(() => parseCron('* 24 * * *')).toThrow()
    expect(() => parseCron('* * 0 * *')).toThrow()
  })

  it('treats dow 7 as Sunday', () => {
    const p = parseCron('0 0 * * 7')
    expect(p.dow.has(0)).toBe(true)
  })
})

describe('cronMatches', () => {
  it('every minute', () => {
    expect(cronMatches('* * * * *', at(2026, 6, 10, 13, 37))).toBe(true)
  })

  it('step on minutes', () => {
    expect(cronMatches('*/30 * * * *', at(2026, 6, 10, 13, 0))).toBe(true)
    expect(cronMatches('*/30 * * * *', at(2026, 6, 10, 13, 30))).toBe(true)
    expect(cronMatches('*/30 * * * *', at(2026, 6, 10, 13, 15))).toBe(false)
  })

  it('specific time of day', () => {
    expect(cronMatches('0 9 * * *', at(2026, 6, 10, 9, 0))).toBe(true)
    expect(cronMatches('0 9 * * *', at(2026, 6, 10, 9, 1))).toBe(false)
    expect(cronMatches('0 9 * * *', at(2026, 6, 10, 10, 0))).toBe(false)
  })

  it('ranges and lists', () => {
    expect(cronMatches('0 9-17 * * *', at(2026, 6, 10, 12, 0))).toBe(true)
    expect(cronMatches('0 9-17 * * *', at(2026, 6, 10, 18, 0))).toBe(false)
    expect(cronMatches('15,45 * * * *', at(2026, 6, 10, 13, 45))).toBe(true)
    expect(cronMatches('15,45 * * * *', at(2026, 6, 10, 13, 30))).toBe(false)
  })

  it('day-of-week (2026-06-10 is a Wednesday = 3)', () => {
    expect(at(2026, 6, 10, 0, 0).getDay()).toBe(3)
    expect(cronMatches('0 0 * * 3', at(2026, 6, 10, 0, 0))).toBe(true)
    expect(cronMatches('0 0 * * 1', at(2026, 6, 10, 0, 0))).toBe(false)
  })

  it('dom + dow both restricted → OR semantics', () => {
    // Matches on the 1st OR on Wednesday.
    expect(cronMatches('0 0 1 * 3', at(2026, 6, 10, 0, 0))).toBe(true) // Wednesday
    expect(cronMatches('0 0 1 * 1', at(2026, 6, 1, 0, 0))).toBe(true) // the 1st (a Monday)
    expect(cronMatches('0 0 1 * 1', at(2026, 6, 10, 0, 0))).toBe(false) // neither
  })
})

describe('isValidCron / nextDescription', () => {
  it('validates', () => {
    expect(isValidCron('*/30 * * * *')).toBe(true)
    expect(() => isValidCron('nope')).toThrow()
  })

  it('describes common patterns', () => {
    expect(nextDescription('* * * * *')).toBe('every minute')
    expect(nextDescription('*/15 * * * *')).toBe('every 15 minutes')
    expect(nextDescription('0 9 * * *')).toBe('daily at 09:00')
  })
})
