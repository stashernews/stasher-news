/* eslint-env jest */
import { announcementParts } from '@/lib/announcement'

test('plain text stays a single text part', () => {
  expect(announcementParts('Polls are live')).toEqual([{ text: 'Polls are live' }])
  expect(announcementParts('')).toEqual([])
})

test('http(s) URLs become links, trailing punctuation stays text', () => {
  expect(announcementParts('Read https://stasher.news/faq#polls. Thanks!')).toEqual([
    { text: 'Read ' },
    { href: 'https://stasher.news/faq#polls', text: 'https://stasher.news/faq#polls' },
    { text: '. Thanks!' }
  ])
  expect(announcementParts('(see http://a.example/x) and https://b.example')).toEqual([
    { text: '(see ' },
    { href: 'http://a.example/x', text: 'http://a.example/x' },
    { text: ') and ' },
    { href: 'https://b.example', text: 'https://b.example' }
  ])
})

test('other schemes and markup are never links', () => {
  expect(announcementParts('javascript:alert(1) <a href="x">y</a> ftp://z')).toEqual([
    { text: 'javascript:alert(1) <a href="x">y</a> ftp://z' }
  ])
})
