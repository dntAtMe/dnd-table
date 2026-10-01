import {
  WIKI_ALIASES_MAX,
  WIKI_BODY_MAX,
  WIKI_CATEGORIES,
  WIKI_CATEGORY_LABELS,
  WIKI_SECRET_MAX,
  WIKI_TAGS_MAX,
  WIKI_TITLE_MAX,
  type WikiAudience,
  type WikiCategory,
} from '@dnd/protocol';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { errorMessage } from '../../lib/api';
import { IMAGE_ACCEPT, uploadFile } from '../../lib/uploads';
import { LinkTextarea } from './LinkTextarea';
import { WikiPageView } from './WikiPageView';
import { awaitWikiPage, pageNameKey, useWiki, type WikiPage } from './wikiStore';
import './wiki.css';

const AUDIENCES: { value: WikiAudience; label: string }[] = [
  { value: 'gm', label: 'GM only' },
  { value: 'all', label: 'Everyone' },
  { value: 'players', label: 'Some players' },
];

/** "Gundren, the dwarf ,, Rockseeker" → ["Gundren", "the dwarf", "Rockseeker"] */
const splitList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return setUrl(null);
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

interface WikiEditorProps {
  /** The page to edit; a new page when left out. */
  page?: WikiPage;
  /** Pre-filled title for a new page. */
  initialTitle?: string;
  onClose: () => void;
}

/** GM: writes or edits a page. Saving keeps the editor open; Done goes back to reading. */
export function WikiEditor({ page, initialTitle = '', onClose }: WikiEditorProps) {
  const { campaignId, pages, members, send } = useWiki();
  const players = useMemo(() => members.filter((m) => m.role === 'player'), [members]);
  const [title, setTitle] = useState(page?.title ?? initialTitle);
  const [aliases, setAliases] = useState(page?.aliases.join(', ') ?? '');
  const [category, setCategory] = useState<WikiCategory>(page?.category ?? 'npc');
  const [tags, setTags] = useState(page?.tags.join(', ') ?? '');
  const [body, setBody] = useState(page?.body ?? '');
  const [secret, setSecret] = useState(page?.secret ?? '');
  const [audience, setAudience] = useState<WikiAudience>(page?.audience ?? 'gm');
  const [userIds, setUserIds] = useState<string[]>(page?.userIds ?? []);
  const [image, setImage] = useState<{ fileId: string; url: string } | null>(
    page?.fileId && page.imageUrl ? { fileId: page.fileId, url: page.imageUrl } : null,
  );
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileUrl = useObjectUrl(file);

  const aliasList = useMemo(() => splitList(aliases), [aliases]);
  const tagList = useMemo(() => splitList(tags), [tags]);
  const cleanTitle = title.trim().replace(/\s+/g, ' ');

  // Titles and aliases must be unique (the server refuses duplicates); say so before saving.
  const clash = useMemo(() => {
    const taken = new Map<string, string>();
    for (const p of pages) {
      if (p.id === page?.id) continue;
      for (const n of [p.title, ...p.aliases]) taken.set(pageNameKey(n), p.title);
    }
    for (const n of [cleanTitle, ...aliasList]) {
      const owner = n && taken.get(pageNameKey(n));
      if (owner) return pageNameKey(owner) === pageNameKey(n) ? `There is already a page called "${owner}".` : `"${n}" is already another name for "${owner}".`;
    }
    if (/[[\]|]/.test([cleanTitle, ...aliasList].join(''))) return 'Names cannot contain [ ] or |.';
    if (aliasList.length > WIKI_ALIASES_MAX) return `At most ${WIKI_ALIASES_MAX} other names.`;
    if (tagList.length > WIKI_TAGS_MAX) return `At most ${WIKI_TAGS_MAX} tags.`;
    if (tagList.some((t) => t.length > 40)) return 'Tags can be at most 40 characters.';
    if (aliasList.some((a) => a.length > WIKI_TITLE_MAX)) return `Names can be at most ${WIKI_TITLE_MAX} characters.`;
    return null;
  }, [pages, page?.id, cleanTitle, aliasList, tagList]);

  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const dirty =
    !page ||
    cleanTitle !== page.title ||
    !same(aliasList, page.aliases) ||
    category !== page.category ||
    !same(tagList, page.tags) ||
    body !== page.body ||
    secret !== (page.secret ?? '') ||
    audience !== page.audience ||
    (audience === 'players' && !sameSet(userIds, page.userIds ?? [])) ||
    Boolean(file) ||
    (image?.fileId ?? null) !== (page.fileId ?? null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!cleanTitle || clash || !send || !campaignId) return;
    setBusy(true);
    setError(undefined);
    try {
      let fileId = image?.fileId ?? null;
      if (file) {
        const up = await uploadFile(campaignId, file);
        if (up.kind !== 'image') throw new Error('Choose an image file');
        fileId = up.id;
        setImage({ fileId: up.id, url: up.url });
        setFile(null);
        if (fileInput.current) fileInput.current.value = '';
      }
      const fields = {
        title: cleanTitle,
        aliases: aliasList,
        category,
        tags: tagList,
        fileId,
        body,
        secret,
        audience,
        userIds: audience === 'players' ? userIds : [],
      };
      if (page) {
        send({ type: 'wiki:update', pageId: page.id, ...fields });
      } else {
        // The Wiki view opens it (in this editor) once the server sends it back.
        awaitWikiPage(cleanTitle, true);
        send({ type: 'wiki:create', ...fields });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    if (page && send && confirm(`Delete the page "${page.title}"? Links to it will show as missing.`)) {
      send({ type: 'wiki:delete', pageId: page.id });
      onClose();
    }
  };

  const toggleUser = (id: string, on: boolean) => setUserIds((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));
  const shownImage = fileUrl ?? image?.url ?? null;
  const draft: WikiPage = {
    id: page?.id ?? 'draft',
    title: cleanTitle || 'Untitled',
    aliases: aliasList,
    category,
    tags: tagList,
    imageUrl: shownImage,
    body,
    authorName: page?.authorName ?? '',
    createdAt: page?.createdAt ?? new Date().toISOString(),
    updatedAt: page?.updatedAt ?? new Date().toISOString(),
    audience,
    userIds,
    secret,
  };

  return (
    <form className="wiki-editor" onSubmit={save}>
      <div className="wiki-editor__head">
        <h3>{page ? 'Edit page' : 'New page'}</h3>
        <div className="segmented" role="tablist" aria-label="Edit or preview">
          <button type="button" role="tab" aria-selected={!preview} className={!preview ? 'is-active' : ''} onClick={() => setPreview(false)}>
            Edit
          </button>
          <button type="button" role="tab" aria-selected={preview} className={preview ? 'is-active' : ''} onClick={() => setPreview(true)}>
            Preview
          </button>
        </div>
      </div>

      {preview ? (
        <div className="wiki-editor__preview">
          <WikiPageView page={draft} compact />
        </div>
      ) : (
        <>
          <div className="wiki-editor__row">
            <label className="field wiki-editor__title">
              <span>Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={WIKI_TITLE_MAX} placeholder="Gundren Rockseeker" required autoFocus={!page} />
            </label>
            <label className="field">
              <span>Category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value as WikiCategory)}>
                {WIKI_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {WIKI_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="field">
            <span>Other names (comma separated; they link to this page too)</span>
            <input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="Gundren, the dwarf" />
          </label>

          <label className="field">
            <span>Tags (comma separated)</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="dwarf, patron, Phandalin" />
          </label>

          <div className="field">
            <span>Image</span>
            {shownImage && (
              <div className="wiki-editor__image">
                <img src={shownImage} alt="" />
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    setFile(null);
                    setImage(null);
                    if (fileInput.current) fileInput.current.value = '';
                  }}
                >
                  Remove image
                </button>
              </div>
            )}
            <label className="file-input">
              <input ref={fileInput} type="file" accept={IMAGE_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <span>{file ? file.name : shownImage ? 'Replace the image' : 'Add a portrait, map or picture (optional)'}</span>
            </label>
          </div>

          <div className="field">
            <span>Text</span>
            <LinkTextarea
              value={body}
              onChange={setBody}
              rows={12}
              maxLength={WIKI_BODY_MAX}
              aria-label="Text"
              exclude={page ? { kind: 'page', id: page.id } : undefined}
              placeholder={'Plain text; leave a blank line between paragraphs.\nType [[ to link a page, spell, monster or rule. Names of pages link by themselves.'}
            />
          </div>

          <div className="field wiki-editor__secret">
            <span>
              Secret notes <span className="badge badge--gm">Never shown to players</span>
            </span>
            <LinkTextarea
              value={secret}
              onChange={setSecret}
              rows={4}
              maxLength={WIKI_SECRET_MAX}
              aria-label="Secret notes"
              exclude={page ? { kind: 'page', id: page.id } : undefined}
              placeholder="What the players don't know (yet)."
            />
          </div>
        </>
      )}

      <fieldset className="fields">
        <legend>Who can read it</legend>
        <div className="segmented segmented--full" role="radiogroup" aria-label="Who can read it">
          {AUDIENCES.map((a) => (
            <button key={a.value} type="button" role="radio" aria-checked={audience === a.value} className={audience === a.value ? 'is-active' : ''} onClick={() => setAudience(a.value)}>
              {a.label}
            </button>
          ))}
        </div>
        {audience === 'gm' && <p className="hint">Only you can see it. Links to it show as plain text for players.</p>}
        {audience === 'all' && <p className="hint">Every player can read it (not the secret notes), including players who join later.</p>}
        {audience === 'players' &&
          (players.length ? (
            <div className="wiki-editor__players">
              {players.map((p) => (
                <label key={p.userId} className="check">
                  <input type="checkbox" checked={userIds.includes(p.userId)} onChange={(e) => toggleUser(p.userId, e.target.checked)} />
                  {p.name}
                </label>
              ))}
            </div>
          ) : (
            <p className="hint">No players have joined yet.</p>
          ))}
      </fieldset>

      {(clash || error) && <p className="form-error">{clash ?? error}</p>}
      <div className="button-row">
        <button type="submit" className="btn btn--primary" disabled={busy || !cleanTitle || Boolean(clash) || !dirty}>
          {busy ? 'Saving…' : page ? (dirty ? 'Save changes' : 'Saved') : 'Create page'}
        </button>
        <button type="button" className="btn" onClick={() => ((page ? !dirty : !cleanTitle && !body.trim()) || confirm('Discard your changes?')) && onClose()}>
          {page ? 'Done' : 'Cancel'}
        </button>
        {page && (
          <button type="button" className="btn btn--ghost wiki-editor__delete" onClick={remove}>
            Delete page
          </button>
        )}
      </div>
    </form>
  );
}
