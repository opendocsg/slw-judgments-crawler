#!/bin/env node
/* eslint-disable no-console */

const axios = require('axios')
const fs = require('fs')
const pdf2md = require('@opendocsg/pdf2md')
const { promisify } = require('util')
const cheerio = require('cheerio')

const promiseToWriteFile = promisify(fs.writeFile)
const promiseToMkDir = promisify(fs.mkdir)

const [
  ,
  ,
  STARTING_URL,
  TARGET_DIR,
] = process.argv

const MATCH_TITLE = /^##? ([^\n]+)\n/
const MATCH_JUDGMENT_NUMBER = /^##? (\[\d{4}] SG.*)$/m
const MATCH_DECISION_DATE = /Decision Date[^:]*:(.*)$/m
const MATCH_TAG_LINES = /^_[^_]+_( – _[^_]+_)+/mg

const BAD_URLS = []
const MISSING_URLS = []

const extractMetadataFrom = (report, titleMatch = MATCH_TITLE) => {
  const [, title] = titleMatch.exec(report)
  const [, judgmentNumber] = MATCH_JUDGMENT_NUMBER.exec(report)
  const [, decisionDate] = MATCH_DECISION_DATE.exec(report)
  const tags = (report.match(MATCH_TAG_LINES) || [])
    .flatMap(line => line.split(/ – /).map(tag => tag.replace(/_/g, '').trim()))

  const yaml = `---
title: "${title}"
subtitle: "${judgmentNumber.trim()} / ${decisionDate.trim().replace(/ /g, '\\_')}"
tags:
${tags.map(tag => `  - ${tag.replace(/"/g, '\\"').replace(/'/g, "\\'")}`).join('\n')}

---
`
  return { judgmentNumber, yaml }
}

const correctFormatting = (report) => {
  return report
    // Bump the judgment title to H1
    .replace(/^##/, '#')
    // Bump the judgment citation to H3
    .replace(/^##/m, '###')
    .replace(/^(\d+)\./mg, '$1\\.')
    .replace(/^(\d{3}) (\w)/mg, '$1    $2')
    .replace(/^(\d{2}) (\w)/mg, '$1     $2')
    .replace(/^(\d{1}) (\w)/mg, '$1       $2')
    // eslint-disable-next-line no-irregular-whitespace
    .replace(/^(\d+) +(January|February|March|April|May|June|July|August|September|October|November|December)/mg, '$1 $2')
}

const scrape = async (url) => {
  const { data } = await axios.get(url, { baseURL: 'https://www.singaporelawwatch.sg/', responseType: 'arraybuffer' })
  const rawReport = await pdf2md(data)

  let index
  try {
    index = extractMetadataFrom(rawReport)
  } catch (e) {
    console.warn(`Bad url ${url}, attempting to extract metadata again`)
    BAD_URLS.push(url)
    try {
      index = extractMetadataFrom(rawReport, /^# ([^\n]+)\n/m)
    } catch (e) {
      console.warn('Attempt failed, skipping')
    }
  }
  const report = correctFormatting(rawReport) + `Source: [link](${url})\n`

  return { report, index }
}

const judgmentsFrom = async (url) => {
  try {
    const response = await axios.get(url)
    let $ = cheerio.load(response.data)
    let links = []
    let next
    $('.DnnModule-EasyDNNnews a[href$=".pdf"]').each(function () {
      let link = $(this)
      let href = link.attr('href')
      links.push(href)
    })
    $('a[class=next]').each(function () {
      let link = $(this)
      let href = link.attr('href')
      next = href
    })
    return { next, listings: links }
  } catch (error) {
    console.error(error)
  }
}

const start = async (startURL) => {
  let listingURL = startURL
  while (listingURL) {
    const { next, listings } = await judgmentsFrom(listingURL)
    for (let url of listings) {
      console.log(`Fetching ${url}`)
      try {
        const { report, index } = await scrape(url)
        const yaml = index && index.yaml
        const judgmentNumber = (index && index.judgmentNumber) || /(\[\d{4}] SG.*)\.pdf/.exec(url)[1]
        const destPath = `${TARGET_DIR}/${judgmentNumber
          .trim()
          .replace(/[\[\]]/g, '')
          .replace(/ /g, '_')}`
        console.log(`Writing to ${destPath}`)
        await promiseToMkDir(destPath, { recursive: true })
          .then(() => Promise.all([
            promiseToWriteFile(`${destPath}/report.md`, report),
            yaml ? promiseToWriteFile(`${destPath}/index.md`, yaml) : Promise.resolve(),
          ]))
      } catch (e) {
        console.warn(`Failed to retrieve ${url}, presumed missing`)
        MISSING_URLS.push(url)
      }
    }
    console.log(`Following on to ${next}`)
    listingURL = next
  }
  console.log(`Follow up on the following:\n ${BAD_URLS.join('\n')}\n`)
  console.log(`These are missing:\n ${MISSING_URLS.join('\n')}\n`)
}

start(STARTING_URL)
