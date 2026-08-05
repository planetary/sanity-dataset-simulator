import {parse} from 'groq-js'
const qs = [
  '[*[sanity::versionOf("article-01")]._id, *[sanity::versionOf("article-02")]._id]',
  '*[sanity::versionOf($id)]',
  '*[sanity::partOfRelease("r")]',
  'releases::all()',
  '*[sanity::versionOf("a") || sanity::versionOf("b")]',
  '*[_id == "a"]{ "v": *[sanity::versionOf(^._id)]._id }',
]
for (const q of qs) {
  try {
    console.log(q, '=>', JSON.stringify(parse(q)))
  } catch (e) {
    console.log(q, 'ERR', e.message)
  }
  console.log('---')
}
