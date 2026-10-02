#!/usr/bin/env node
// Builds the website (GitHub Pages) into _site/: the product page from site/index.html, and the
// docs rendered from the Markdown that lives in the repo, so they never drift apart:
//   user-guide.html  ← docs/user-guide.md
//   install.html     ← README.md, from "Running it" up to "Rules content"
//   changelog.html   ← CHANGELOG.md
//
//   pnpm site    # then open _site/index.html, or serve the folder
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '_site');
const REPO = 'https://github.com/dntAtMe/dnd-table';
const read = (p) => readFileSync(path.join(root, p), 'utf8');

const { version } = JSON.parse(read('package.json'));
const attribution = JSON.parse(read('packages/rules/src/srd/data/manifest.json')).license;
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500..700;1,9..144,500..700&family=Inter:wght@400..700&display=swap" />`;

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Where a link in a Markdown file (relative to `from`) points on the website. */
function siteHref(href, from) {
  if (/^([a-z]+:|#)/i.test(href)) return href;
  const [file, hash] = href.split('#');
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), file));
  const anchor = hash ? `#${hash}` : '';
  if (target === 'docs/user-guide.md') return `user-guide.html${anchor}`;
  if (target === 'README.md') return `install.html${anchor}`;
  if (target === 'CHANGELOG.md') return `changelog.html${anchor}`;
  if (target.startsWith('docs/screenshots/')) return target.slice('docs/'.length);
  return `${REPO}/blob/main/${target}${anchor}`;
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, repeats numbered. */
function slugger() {
  const used = new Map();
  return (text) => {
    const base = text
      .toLowerCase()
      .trim()
      .replace(/<[^>]+>/g, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

/** Markdown to HTML with anchored headings, site links and the h2/h3 outline. */
function render(markdown, from) {
  const slug = slugger();
  const outline = [];
  let title = '';
  const marked = new Marked({
    gfm: true,
    walkTokens(token) {
      if ((token.type === 'link' || token.type === 'image') && token.href) token.href = siteHref(token.href, from);
    },
    renderer: {
      heading({ tokens, depth, text }) {
        const html = this.parser.parseInline(tokens);
        const plain = text.replace(/[*_`]/g, '');
        if (depth === 1) {
          title ||= plain;
          return `<h1>${html}</h1>\n`;
        }
        const id = slug(plain);
        if (depth <= 3) outline.push({ depth, id, text: plain });
        return `<h${depth} id="${id}">${html}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
    },
  });
  const html = marked.parse(markdown);
  const toc = `<ul>${outline
    .map((h) => `<li${h.depth === 3 ? ' class="toc__sub"' : ''}><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
    .join('')}</ul>`;
  return { html, toc, title };
}

/** The README's section from one "## " heading up to (not including) another. */
function readmeSection(from, to) {
  const md = read('README.md');
  const start = md.indexOf(`\n## ${from}\n`);
  const end = md.indexOf(`\n## ${to}\n`);
  if (start < 0 || end < 0) throw new Error(`README: no "## ${from}" … "## ${to}" section`);
  return md.slice(start, end);
}

function fill(template, page, vars) {
  let html = template
    .replace('{{nav}}', read('site/_nav.html'))
    .replace('{{footer}}', read('site/_footer.html'))
    .replace(/\{\{current:([a-z-]+)\}\}/g, (_, p) => (p === page ? ' aria-current="page"' : ''));
  const all = { fonts: FONTS, repo: REPO, version, attribution: escapeHtml(attribution), ...vars };
  html = html.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in all ? all[key] : m));
  if (/\{\{\w+\}\}/.test(html)) throw new Error(`${page}: unfilled ${html.match(/\{\{\w+\}\}/)[0]}`);
  return html;
}

const pages = [
  {
    page: 'user-guide',
    source: 'docs/user-guide.md',
    markdown: read('docs/user-guide.md'),
    description: 'How to set up a dnd-table session, play a character and run the game as GM.',
  },
  {
    page: 'install',
    source: 'README.md',
    markdown: `# Install and hosting\n${readmeSection('Running it', 'Rules content')}`,
    description: 'Run dnd-table on your own computer, configure it, back it up and host it online.',
  },
  {
    page: 'changelog',
    source: 'CHANGELOG.md',
    markdown: read('CHANGELOG.md'),
    description: "What's new in each dnd-table release.",
  },
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, 'site/site.css'), path.join(out, 'site.css'));
cpSync(path.join(root, 'apps/web/public/favicon.svg'), path.join(out, 'favicon.svg'));
cpSync(path.join(root, 'docs/screenshots'), path.join(out, 'screenshots'), { recursive: true });
writeFileSync(path.join(out, '.nojekyll'), '');
writeFileSync(path.join(out, 'index.html'), fill(read('site/index.html'), 'home', {}));

const docTemplate = read('site/doc.html');
for (const p of pages) {
  const { html, toc, title } = render(p.markdown, p.source);
  writeFileSync(
    path.join(out, `${p.page}.html`),
    fill(docTemplate, p.page, { title: escapeHtml(title), description: escapeHtml(p.description), content: html, toc, source: p.source }),
  );
}

// Every local link and image must lead somewhere.
const broken = [];
for (const file of ['index.html', ...pages.map((p) => `${p.page}.html`)]) {
  const html = readFileSync(path.join(out, file), 'utf8');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, ref] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^([a-z]+:|\/\/)/i.test(ref)) continue;
    const [target, hash] = ref.split('#');
    const targetFile = target || file;
    if (!existsSync(path.join(out, targetFile))) broken.push(`${file} → ${ref}`);
    else if (hash) {
      const targetIds = target ? new Set([...readFileSync(path.join(out, targetFile), 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])) : ids;
      if (!targetIds.has(decodeURIComponent(hash))) broken.push(`${file} → ${ref}`);
    }
  }
}
if (broken.length) throw new Error(`Broken links:\n  ${broken.join('\n  ')}`);

console.log(`Website for dnd-table ${version} → ${path.relative(process.cwd(), out)}/ (${pages.length + 1} pages)`);
