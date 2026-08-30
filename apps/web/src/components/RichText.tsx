/**
 * A small rich-text editor over contentEditable.
 *
 * Deliberately not a framework. The server sanitizes every save against the same
 * allow-list it uses for mail, so the editor's job is to produce that subset and no
 * more - headings, emphasis, lists, links, quotes and code. A large editor would
 * produce markup the sanitizer strips on the way in, which reads to the person typing
 * as the application losing their work.
 *
 * The value is uncontrolled after mount on purpose: writing innerHTML on every
 * keystroke resets the caret to the start of the document, which makes typing
 * impossible.
 */
import { useEffect, useRef, useState } from 'react';

type Command = { label: string; title: string; run: (exec: typeof document.execCommand) => void };

const COMMANDS: Command[] = [
  { label: 'B', title: 'Bold', run: (e) => e('bold') },
  { label: 'I', title: 'Italic', run: (e) => e('italic') },
  { label: 'H2', title: 'Heading', run: (e) => e('formatBlock', false, 'h2') },
  { label: 'H3', title: 'Subheading', run: (e) => e('formatBlock', false, 'h3') },
  { label: '¶', title: 'Paragraph', run: (e) => e('formatBlock', false, 'p') },
  { label: '• List', title: 'Bulleted list', run: (e) => e('insertUnorderedList') },
  { label: '1. List', title: 'Numbered list', run: (e) => e('insertOrderedList') },
  { label: '❝', title: 'Quote', run: (e) => e('formatBlock', false, 'blockquote') },
  { label: '</>', title: 'Code block', run: (e) => e('formatBlock', false, 'pre') },
];

export function RichText({
  value,
  onChange,
  ariaLabelledBy,
}: {
  value: string;
  onChange: (html: string) => void;
  ariaLabelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [showSource, setShowSource] = useState(false);

  // Seed once. Later updates come from typing, so re-writing innerHTML would fight
  // the caret rather than help.
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value && document.activeElement !== ref.current) {
      ref.current.innerHTML = value || '<p></p>';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSource]);

  const exec = ((...args: Parameters<typeof document.execCommand>) => {
    const result = document.execCommand(...args);
    if (ref.current) onChange(ref.current.innerHTML);
    return result;
  }) as typeof document.execCommand;

  function addLink() {
    const url = window.prompt('Link address (https://…)');
    if (!url) return;
    // Only http(s): a javascript: or data: href here would be a script the sanitizer
    // has to catch on the way out. Refusing it at the source is clearer to the author.
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        window.alert('Links must start with http:// or https://');
        return;
      }
    } catch {
      window.alert('That is not a valid address');
      return;
    }
    exec('createLink', false, url);
  }

  if (showSource) {
    return (
      <div className="rich-text">
        <div className="rich-text-toolbar">
          <button type="button" className="ghost-button" onClick={() => setShowSource(false)}>
            Back to editor
          </button>
        </div>
        <textarea
          className="rich-text-source"
          rows={18}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-labelledby={ariaLabelledBy}
        />
      </div>
    );
  }

  return (
    <div className="rich-text">
      <div className="rich-text-toolbar" role="toolbar" aria-label="Formatting">
        {COMMANDS.map((command) => (
          <button
            key={command.label}
            type="button"
            className="rich-text-tool"
            title={command.title}
            aria-label={command.title}
            // Mouse-down rather than click: clicking moves focus out of the editable
            // area first, which collapses the selection the command needs.
            onMouseDown={(event) => {
              event.preventDefault();
              command.run(exec);
            }}
          >
            {command.label}
          </button>
        ))}
        <button type="button" className="rich-text-tool" title="Link" aria-label="Link"
                onMouseDown={(event) => { event.preventDefault(); addLink(); }}>
          🔗
        </button>
        <button type="button" className="ghost-button" style={{ marginLeft: 'auto' }}
                onClick={() => setShowSource(true)}>
          HTML
        </button>
      </div>
      <div
        ref={ref}
        className="rich-text-surface doc-body"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-labelledby={ariaLabelledBy}
        onInput={(event) => onChange((event.target as HTMLDivElement).innerHTML)}
        onBlur={(event) => onChange((event.target as HTMLDivElement).innerHTML)}
      />
    </div>
  );
}
