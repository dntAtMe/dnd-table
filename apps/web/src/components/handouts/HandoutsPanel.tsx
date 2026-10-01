import { HANDOUT_TEXT_MAX, type ClientMessage, type HandoutAudience, type HandoutView, type Member, type Showcase } from '@dnd/protocol';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { errorMessage } from '../../lib/api';
import { IMAGE_ACCEPT, uploadFile } from '../../lib/uploads';
import { HandoutText } from './HandoutText';
import './handouts.css';

type Send = (msg: ClientMessage) => void;

interface HandoutsPanelProps {
  campaignId: string;
  handouts: HandoutView[];
  members: Member[];
  isGm: boolean;
  showcase: Showcase | null;
  send: Send;
}

/** The Handouts view: an authoring desk for the GM, a journal for players. */
export function HandoutsPanel(props: HandoutsPanelProps) {
  return props.isGm ? <HandoutDesk {...props} /> : <HandoutJournal handouts={props.handouts} send={props.send} />;
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
}

function audienceLabel(h: HandoutView, players: Member[]): string {
  if (h.audience === 'all') return 'Everyone';
  if (h.audience === 'players') {
    const names = players.filter((p) => h.userIds?.includes(p.userId)).map((p) => p.name);
    return names.length ? names.join(', ') : 'Nobody yet';
  }
  return 'Draft';
}

// ---------- GM ----------

/** "On the table: …" with a way back to the map. Shown to the GM wherever they are. */
export function ShowcaseStatus({ showcase, send, className = '' }: { showcase: Showcase; send: Send; className?: string }) {
  return (
    <div className={`showcase-status ${className}`} role="status">
      <span className="showcase-status__text">
        On the table: <strong>{showcase.title || 'Image'}</strong>
        {showcase.toPlayers && <span className="showcase-status__extra"> · players too</span>}
      </span>
      <button type="button" className="btn btn--sm btn--primary" onClick={() => send({ type: 'showcase:clear' })}>
        Back to map
      </button>
    </div>
  );
}

function HandoutDesk({ campaignId, handouts, members, showcase, send }: HandoutsPanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const players = useMemo(() => members.filter((m) => m.role === 'player'), [members]);
  const awaitingNew = useRef<number | null>(null);

  // After creating one, open it as soon as the server sends it back (the list is newest first).
  useEffect(() => {
    if (awaitingNew.current !== null && handouts.length > awaitingNew.current) {
      awaitingNew.current = null;
      setSelected(handouts[0]!.id);
    }
  }, [handouts]);

  const current = selected && selected !== 'new' ? handouts.find((h) => h.id === selected) : undefined;
  const open = selected === 'new' || Boolean(current);

  return (
    <div className={`handouts handouts--desk${open ? ' handouts--open' : ''}`}>
      <div className="handouts__side">
        <div className="handouts__head">
          <h2>Handouts</h2>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => setSelected('new')}>
            New handout
          </button>
        </div>
        {showcase && <ShowcaseStatus showcase={showcase} send={send} />}
        {handouts.length === 0 ? (
          <p className="hint">Letters, wanted posters, maps and portraits for your players. Write one, then share it or show it on the table.</p>
        ) : (
          <ul className="handouts__list">
            {handouts.map((h) => (
              <li key={h.id}>
                <button type="button" className={`handout-item${h.id === selected ? ' is-active' : ''}`} onClick={() => setSelected(h.id)}>
                  {h.imageUrl ? <img src={h.imageUrl} alt="" className="handout-item__thumb" /> : <span className="handout-item__thumb handout-item__thumb--text" aria-hidden="true" />}
                  <span className="handout-item__body">
                    <span className="handout-item__title">{h.title}</span>
                    <span className="handout-item__meta">
                      <span className={`badge${h.audience === 'gm' ? ' badge--gm' : ''}`}>{audienceLabel(h, players)}</span>
                      {showcase?.handoutId === h.id && <span className="badge badge--live">On table</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="handouts__main">
        {selected === 'new' ? (
          <HandoutEditor
            key="new"
            campaignId={campaignId}
            players={players}
            showcase={showcase}
            send={send}
            onCreated={() => (awaitingNew.current = handouts.length)}
            onClose={() => setSelected(null)}
          />
        ) : current ? (
          <HandoutEditor
            key={current.id}
            campaignId={campaignId}
            handout={current}
            players={players}
            showcase={showcase}
            send={send}
            onClose={() => setSelected(null)}
          />
        ) : (
          <QuickShow campaignId={campaignId} send={send} />
        )}
      </div>
    </div>
  );
}

interface EditorProps {
  campaignId: string;
  handout?: HandoutView;
  players: Member[];
  showcase: Showcase | null;
  send: Send;
  onCreated?: () => void;
  onClose: () => void;
}

const AUDIENCES: { value: HandoutAudience; label: string }[] = [
  { value: 'gm', label: 'Draft' },
  { value: 'all', label: 'Everyone' },
  { value: 'players', label: 'Some players' },
];

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

function HandoutEditor({ campaignId, handout, players, showcase, send, onCreated, onClose }: EditorProps) {
  const [title, setTitle] = useState(handout?.title ?? '');
  const [text, setText] = useState(handout?.text ?? '');
  const [audience, setAudience] = useState<HandoutAudience>(handout?.audience ?? 'gm');
  const [userIds, setUserIds] = useState<string[]>(handout?.userIds ?? []);
  const [image, setImage] = useState<{ fileId: string; url: string } | null>(
    handout?.fileId && handout.imageUrl ? { fileId: handout.fileId, url: handout.imageUrl } : null,
  );
  const [file, setFile] = useState<File | null>(null);
  const [toPlayers, setToPlayers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileUrl = useObjectUrl(file);

  const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));
  const dirty =
    !handout ||
    title.trim() !== handout.title ||
    text !== handout.text ||
    audience !== handout.audience ||
    (audience === 'players' && !sameIds(userIds, handout.userIds ?? [])) ||
    Boolean(file) ||
    (image?.fileId ?? null) !== (handout.fileId ?? null);
  const onTable = Boolean(handout && showcase?.handoutId === handout.id);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
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
      const fields = { title: title.trim(), text, fileId, audience, userIds: audience === 'players' ? userIds : [] };
      if (handout) send({ type: 'handout:update', handoutId: handout.id, ...fields });
      else {
        send({ type: 'handout:create', ...fields });
        onCreated?.();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    if (handout && confirm(`Delete "${handout.title}"?`)) {
      send({ type: 'handout:delete', handoutId: handout.id });
      onClose();
    }
  };

  const toggleUser = (id: string, on: boolean) => setUserIds((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));
  const shownImage = fileUrl ?? image?.url ?? null;

  return (
    <form className="handout-editor" onSubmit={save}>
      <div className="handout-editor__head">
        <button type="button" className="btn btn--ghost btn--sm handouts__back" onClick={onClose}>
          ← All handouts
        </button>
        <h3>{handout ? 'Edit handout' : 'New handout'}</h3>
        <div className="segmented handout-editor__mode" role="tablist" aria-label="Edit or preview">
          <button type="button" role="tab" aria-selected={!preview} className={!preview ? 'is-active' : ''} onClick={() => setPreview(false)}>
            Edit
          </button>
          <button type="button" role="tab" aria-selected={preview} className={preview ? 'is-active' : ''} onClick={() => setPreview(true)}>
            Preview
          </button>
        </div>
      </div>

      {preview ? (
        <article className="handout-card">
          <h2 className="handout-card__title">{title.trim() || 'Untitled'}</h2>
          {shownImage && <img src={shownImage} alt="" className="handout-card__image" />}
          <HandoutText text={text} />
        </article>
      ) : (
        <>
          <label className="field">
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="A letter sealed with black wax" required />
          </label>

          <div className="field">
            <span>Image</span>
            {shownImage && (
              <div className="handout-editor__image">
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
              <span>{file ? file.name : shownImage ? 'Replace the image' : 'Add an image (optional)'}</span>
            </label>
          </div>

          <label className="field">
            <span>Text</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              maxLength={HANDOUT_TEXT_MAX}
              placeholder="Plain text. Leave a blank line between paragraphs."
            />
          </label>
        </>
      )}

      <fieldset className="fields">
        <legend>Share with</legend>
        <div className="segmented segmented--full" role="radiogroup" aria-label="Share with">
          {AUDIENCES.map((a) => (
            <button
              key={a.value}
              type="button"
              role="radio"
              aria-checked={audience === a.value}
              className={audience === a.value ? 'is-active' : ''}
              onClick={() => setAudience(a.value)}
            >
              {a.label}
            </button>
          ))}
        </div>
        {audience === 'gm' && <p className="hint">Only you can see a draft. You can still show it on the table.</p>}
        {audience === 'all' && <p className="hint">Every player gets it in their journal, including players who join later.</p>}
        {audience === 'players' &&
          (players.length ? (
            <div className="handout-editor__players">
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

      {error && <p className="form-error">{error}</p>}
      <div className="button-row">
        <button type="submit" className="btn btn--primary" disabled={busy || !title.trim() || !dirty}>
          {busy ? 'Saving…' : handout ? (dirty ? 'Save changes' : 'Saved') : 'Create handout'}
        </button>
        {handout && (
          <button type="button" className="btn btn--ghost" onClick={remove}>
            Delete
          </button>
        )}
      </div>

      {handout && (
        <fieldset className="fields">
          <legend>Table screens</legend>
          {onTable ? (
            <button type="button" className="btn" onClick={() => send({ type: 'showcase:clear' })}>
              Back to map
            </button>
          ) : (
            <>
              <label className="check">
                <input type="checkbox" checked={toPlayers} onChange={(e) => setToPlayers(e.target.checked)} />
                Also pop it up on players' screens
              </label>
              <button type="button" className="btn" onClick={() => send({ type: 'showcase:show', handoutId: handout.id, toPlayers })}>
                Show on table
              </button>
              {dirty && <p className="hint">Save first to show your latest changes.</p>}
            </>
          )}
        </fieldset>
      )}
    </form>
  );
}

/** Pushes any image straight to the table without making a handout of it. */
function QuickShow({ campaignId, send }: { campaignId: string; send: Send }) {
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [toPlayers, setToPlayers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  const show = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      const up = await uploadFile(campaignId, file);
      if (up.kind !== 'image') throw new Error('Choose an image file');
      send({ type: 'showcase:show', fileId: up.id, title: caption.trim() || undefined, toPlayers });
      setFile(null);
      setCaption('');
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="handout-editor quick-show" onSubmit={show}>
      <h3>Show an image on the table</h3>
      <p className="hint">Pick a handout on the left to edit it, or put any picture up on the table screens right now.</p>
      <label className="file-input">
        <input ref={fileInput} type="file" accept={IMAGE_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <span>{file ? file.name : 'Choose an image'}</span>
      </label>
      <input value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={120} placeholder="Caption (optional)" aria-label="Caption" />
      <label className="check">
        <input type="checkbox" checked={toPlayers} onChange={(e) => setToPlayers(e.target.checked)} />
        Also pop it up on players' screens
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="button-row">
        <button type="submit" className="btn btn--primary" disabled={!file || busy}>
          {busy ? 'Uploading…' : 'Show on table'}
        </button>
      </div>
    </form>
  );
}

// ---------- players ----------

function HandoutJournal({ handouts, send }: { handouts: HandoutView[]; send: Send }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = handouts.find((h) => h.id === openId);

  useEffect(() => {
    if (open?.unread) send({ type: 'handout:read', handoutId: open.id });
  }, [open?.id, open?.unread, send]);

  return (
    <div className={`handouts${open ? ' handouts--open' : ''}`}>
      <div className="handouts__side">
        <div className="handouts__head">
          <h2>Handouts</h2>
        </div>
        {handouts.length === 0 ? (
          <p className="hint">Nothing yet. Letters, maps and pictures the GM shares with you will appear here.</p>
        ) : (
          <ul className="handouts__list">
            {handouts.map((h) => (
              <li key={h.id}>
                <button type="button" className={`handout-item${h.id === openId ? ' is-active' : ''}`} onClick={() => setOpenId(h.id)}>
                  {h.imageUrl ? <img src={h.imageUrl} alt="" className="handout-item__thumb" /> : <span className="handout-item__thumb handout-item__thumb--text" aria-hidden="true" />}
                  <span className="handout-item__body">
                    <span className="handout-item__title">{h.title}</span>
                    <span className="handout-item__meta">{formatDate(h.sharedAt)}</span>
                  </span>
                  {h.unread && <span className="handout-item__unread" aria-label="unread" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="handouts__main">
        {open ? (
          <article className="handout-card">
            <button type="button" className="btn btn--ghost btn--sm handouts__back" onClick={() => setOpenId(null)}>
              ← All handouts
            </button>
            <h2 className="handout-card__title">{open.title}</h2>
            {open.imageUrl && (
              <a href={open.imageUrl} target="_blank" rel="noreferrer" className="handout-card__image-link">
                <img src={open.imageUrl} alt={open.title} className="handout-card__image" />
              </a>
            )}
            <HandoutText text={open.text} />
          </article>
        ) : (
          handouts.length > 0 && <p className="hint handouts__placeholder">Choose a handout to read it.</p>
        )}
      </div>
    </div>
  );
}
