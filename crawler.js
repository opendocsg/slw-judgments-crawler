#!/bin/env node

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

const MATCH_TITLE = /^# ([^\n]+)\n/
const MATCH_JUDGMENT_NUMBER = /^# (\[20\d\d\] SG.*)$/m
const MATCH_DECISION_DATE = /^..Decision Date.. :(.*)$/m
const MATCH_TAG_LINES = /^_[^_]+_( – _[^_]+_)+/mg

const extractMetadataFrom = (report) => {
  const [, title] = MATCH_TITLE.exec(report)
  const [, judgmentNumber] = MATCH_JUDGMENT_NUMBER.exec(report)
  const [, decisionDate] = MATCH_DECISION_DATE.exec(report)
  const tags = (report.match(MATCH_TAG_LINES) || [])
    .flatMap(line => line.split(/ – /).map(tag => tag.replace(/_/g, '').trim()))

  const yaml = `---
title: ${title}
subtitle: "${judgmentNumber.trim()} / ${decisionDate.trim().replace(/ /g, '\\_')}"
tags:
${tags.map(tag => ` - ${tag}`).join('\n')}

---
`
  return { judgmentNumber, yaml }
}

const correctFormatting = (report) => {
  return report
    .replace(/^(\d+)\./mg, '$1\\.')
    .replace(/^(\d{3}) (\w)/mg, '$1    $2')
    .replace(/^(\d{2}) (\w)/mg, '$1     $2')
    .replace(/^(\d{1}) (\w)/mg, '$1       $2')
    .replace(/^(\d+) +(January|February|March|April|May|June|July|August|September|October|November|December)/mg, '$1 $2')
    .replace(MATCH_JUDGMENT_NUMBER, '')
}

const scrape = async (url) => {
  const { data } = await axios.get(url, { responseType: 'arraybuffer' })
  const rawReport = await pdf2md(data)

  const index = extractMetadataFrom(rawReport)
  const report = correctFormatting(rawReport) + `Source: [link](${url})\n`

  return { report, index }
}

const judgmentsFrom = async (url) => {
  try {
    const response = await axios.get(url)
    let $ = cheerio.load(response.data)
    let links = []
    let next = undefined
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
    for (url of listings) {
      console.log(`Fetching ${url}`)
      const { report, index: { yaml, judgmentNumber } } = await scrape(url)
      const destPath = `${TARGET_DIR}/${judgmentNumber
        .trim()
        .replace(/[\[\]]/g, '')
        .replace(/ /g, '_')}`
      console.log(`Writing to ${destPath}`)
      await promiseToMkDir(destPath, { recursive: true })
        .then(() => Promise.all([
          promiseToWriteFile(`${destPath}/report.md`, report),
          promiseToWriteFile(`${destPath}/index.md`, yaml),
        ]))
    }
    listingURL = next
  }
}

start(STARTING_URL)
