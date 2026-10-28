import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDateTime, titleCase } from '../api';
import { useAction } from '../hooks';
import {
  Card,
  ErrorNote,
  Icon,
  JsonView,
  PageHeader,
  Spinner,
  StatusPill,
} from '../ui';
import { entityLabel, entityLink } from '../links';

interface Citation {
  type: string;
  id: string;
  label: string;
}

interface AssistantResult {
  intent: string;
  answer: string;
  citations: Citation[];
  data: unknown;
}

interface ChatEntry {
  id: string;
  question: string;
  askedAt: string;
  result?: AssistantResult;
  error?: string;
}

const SUGGESTIONS = [
  'How much stock do we have for AHP00001?',
  'Which SKUs are below the low-stock threshold?',
  'Which batches are expiring soon?',
  'Show open exceptions',
  'Show the latest orders',
  'What stock movements happened recently?',
];

export function AssistantPage() {
  const action = useAction();
  const [question, setQuestion] = useState('');
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const endRef = useRef<HTMLDivElement | null>(null);

  const ask = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const entry: ChatEntry = {
      id: crypto.randomUUID(),
      question: trimmed,
      askedAt: new Date().toISOString(),
    };
    setQuestion('');
    setEntries((current) => [...current, entry]);
    const result = await action.run(() => api.post<AssistantResult>('/assistant', { question: trimmed }));
    setEntries((current) =>
      current.map((item) =>
        item.id === entry.id
          ? {
              ...item,
              result: result ?? undefined,
              error: result ? undefined : 'The assistant could not answer that question. See the error below.',
            }
          : item,
      ),
    );
    window.setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 60);
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="AI assistant"
        title="Grounded operations assistant"
        subtitle="Answers are computed from live balances, batches, orders and exceptions by the backend. The assistant is read-only and every question is written to the AI action log."
        actions={
          entries.length ? (
            <button type="button" className="btn btn-subtle" onClick={() => setEntries([])}>
              <Icon name="refresh" size={15} /> New conversation
            </button>
          ) : null
        }
      />

      <div className="assistant-layout">
        <Card
          title="Conversation"
          subtitle="Ask about stock, low stock, expiry, orders, exceptions, movement history or any record number."
          className="assistant-chat"
        >
          <div className="chat-log">
            <div className="chat-bubble assistant">
              <span className="chat-author">Aaradhya Assistant</span>
              <p>
                I can look up stock by SKU or product name, list low-stock SKUs, expiring batches, open exceptions,
                recent orders and recent movements. I never change data — stock corrections belong in adjustments or
                cycle counts.
              </p>
            </div>

            {entries.map((entry) => (
              <div className="chat-entry" key={entry.id}>
                <div className="chat-bubble user">
                  <span className="chat-author">You · {formatDateTime(entry.askedAt)}</span>
                  <p>{entry.question}</p>
                </div>
                {entry.result ? (
                  <div className="chat-bubble assistant">
                    <div className="chat-meta">
                      <span className="chat-author">Assistant</span>
                      <StatusPill value={titleCase(entry.result.intent)} tone="info" dot={false} />
                    </div>
                    <p>{entry.result.answer}</p>
                    {entry.result.citations.length ? (
                      <div className="citations">
                        <span className="muted tiny">Sources</span>
                        <div className="tag-list">
                          {entry.result.citations.map((citation, index) => {
                            const link = entityLink(citation.type, citation.id);
                            const label = citation.label || entityLabel(citation.type);
                            return link ? (
                              <Link className="chip" key={`${citation.type}-${citation.id}-${index}`} to={link}>
                                <Icon name="external" size={12} /> {label}
                              </Link>
                            ) : (
                              <span className="chip" key={`${citation.type}-${citation.id}-${index}`}>
                                {label}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                    {entry.result.data !== null && entry.result.data !== undefined ? (
                      <details className="json-details">
                        <summary>Supporting data</summary>
                        <JsonView value={entry.result.data} />
                      </details>
                    ) : null}
                  </div>
                ) : entry.error ? (
                  <div className="chat-bubble assistant error">
                    <span className="chat-author">Assistant</span>
                    <p>{entry.error}</p>
                  </div>
                ) : (
                  <div className="chat-bubble assistant">
                    <Spinner label="Querying live warehouse data…" />
                  </div>
                )}
              </div>
            ))}
            <div ref={endRef} />
          </div>

          <form
            className="chat-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void ask(question);
            }}
          >
            <textarea
              className="input textarea"
              rows={2}
              maxLength={1000}
              value={question}
              placeholder="Ask a question, e.g. “Which batches expire in the next 30 days?”"
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void ask(question);
                }
              }}
              disabled={action.running}
            />
            <div className="chat-composer-actions">
              <span className="muted tiny">Enter to send · Shift+Enter for a new line</span>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={action.running || question.trim().length === 0}
              >
                {action.running ? 'Thinking…' : 'Ask'}
                <Icon name="arrowRight" size={16} />
              </button>
            </div>
            <ErrorNote error={action.error} />
          </form>
        </Card>

        <div className="assistant-side">
          <Card title="Suggested questions">
            <div className="stack tight">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="suggestion"
                  disabled={action.running}
                  onClick={() => void ask(suggestion)}
                >
                  <span>{suggestion}</span>
                  <Icon name="arrowRight" size={14} />
                </button>
              ))}
            </div>
          </Card>
          <Card title="How it works">
            <ul className="plain-list">
              <li>Grounded in the same canonical balances and ledger used by every screen.</li>
              <li>Read-only: no movement, approval or configuration can be performed here.</li>
              <li>Questions and answers are written to the AI action log with your user, intent and outcome.</li>
              <li>Cost data is not included in assistant answers.</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
