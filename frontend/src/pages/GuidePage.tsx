import { Link } from 'react-router-dom';
import { downloadPath, formatDate } from '../api';
import { useApi, useAction } from '../hooks';
import { useToast } from '../toast';
import { Card, ErrorNote, Icon, Spinner } from '../ui';

interface GuideLink {
  label: string;
  to: string;
}

interface GuideSection {
  id: string;
  title: string;
  who: string;
  summary: string;
  steps: Array<{ title: string; detail: string }>;
  tips: string[];
  links: GuideLink[];
}

interface GuideContent {
  title: string;
  subtitle: string;
  version: string;
  updatedAt: string;
  intro: string;
  goldenRules: string[];
  roles: Array<{ code: string; name: string; focus: string }>;
  sections: GuideSection[];
  checklist: string[];
  glossary: Array<{ term: string; meaning: string }>;
}

export function GuidePage() {
  const state = useApi<{ guide: GuideContent }>('/guide');
  const download = useAction();
  const toast = useToast();
  const guide = state.data?.guide;

  const downloadPdf = async () => {
    const name = await download.run(() => downloadPath('/guide.pdf', 'warehouse-user-guide.pdf'));
    if (name) toast.notify(`Saved ${name}.`, 'success');
  };

  if (!guide) {
    return (
      <div className="page">
        <ErrorNote error={state.error} />
        {state.loading ? <Spinner label="Opening the user guide…" /> : null}
      </div>
    );
  }

  return (
    <div className="page">
      <section className="guide-hero">
        <div>
          <div className="eyebrow">New joiner guide · Hinglish</div>
          <h1>{guide.title}</h1>
          <p>{guide.subtitle}</p>
          <div className="guide-meta-row">
            <span className="guide-chip">Version {guide.version}</span>
            <span className="guide-chip">Updated {formatDate(guide.updatedAt)}</span>
            <span className="guide-chip">{guide.sections.length} sections</span>
            <span className="guide-chip">Every warehouse role</span>
          </div>
        </div>
        <div className="guide-hero-actions">
          <button type="button" className="btn btn-primary" disabled={download.running} onClick={() => void downloadPdf()}>
            <Icon name="download" size={16} /> {download.running ? 'Preparing…' : 'Download PDF'}
          </button>
          <a className="btn btn-hero-ghost" href="#golden-rules">
            <Icon name="play" size={15} /> Start reading
          </a>
        </div>
      </section>
      <ErrorNote error={download.error} />

      <Card className="guide-intro">
        <p>{guide.intro}</p>
      </Card>

      <div className="guide-layout">
        <aside className="guide-toc" aria-label="Guide contents">
          <div className="guide-toc-label">Contents</div>
          <a href="#golden-rules">6 golden rules</a>
          <a href="#roles">Roles</a>
          {guide.sections.map((section) => (
            <a key={section.id} href={`#${section.id}`}>
              {section.title}
            </a>
          ))}
          <a href="#checklist">Daily checklist</a>
          <a href="#glossary">Glossary</a>
        </aside>

        <div className="stack">
          <div id="golden-rules" className="guide-section">
            <Card title="6 golden rules" subtitle="Inhe yaad rakhna - baaki sab isi se follow hota hai.">
              <div className="guide-rules">
                {guide.goldenRules.map((rule, index) => (
                  <div className="guide-rule" key={rule}>
                    <span className="guide-rule-no">{index + 1}</span>
                    <span>{rule}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div id="roles" className="guide-section">
            <Card title="Roles" subtitle="Har role ka focus alag hai - apna role pehchanein.">
              <div className="guide-roles">
                {guide.roles.map((role) => (
                  <div className="guide-role" key={role.code}>
                    <strong>{role.name}</strong>
                    <code className="code">{role.code}</code>
                    <p className="muted small">{role.focus}</p>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {guide.sections.map((section) => (
            <div id={section.id} className="guide-section" key={section.id}>
              <Card
                title={section.title}
                subtitle={section.summary}
                actions={<span className="guide-who">{section.who}</span>}
              >
                <ol className="guide-steps">
                  {section.steps.map((step, stepIndex) => (
                    <li key={`${section.id}-${stepIndex}`}>
                      <span className="guide-step-no">{stepIndex + 1}</span>
                      <div>
                        <strong>{step.title}</strong>
                        <p className="muted small">{step.detail}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                {section.tips.length ? (
                  <ul className="guide-tips">
                    {section.tips.map((tip) => (
                      <li key={tip}>{tip}</li>
                    ))}
                  </ul>
                ) : null}
                {section.links.length ? (
                  <div className="guide-links">
                    {section.links.map((link) =>
                      link.to.startsWith('/') ? (
                        <Link className="btn btn-subtle btn-sm" to={link.to} key={link.to}>
                          {link.label} <Icon name="chevron" size={13} />
                        </Link>
                      ) : (
                        <a className="btn btn-subtle btn-sm" href={link.to} key={link.to}>
                          {link.label} <Icon name="external" size={13} />
                        </a>
                      ),
                    )}
                  </div>
                ) : null}
              </Card>
            </div>
          ))}

          <div id="checklist" className="guide-section">
            <Card title="Daily checklist" subtitle="Shift ke start aur end mein ye list check karein.">
              <div className="guide-check">
                {guide.checklist.map((item) => (
                  <div className="guide-check-item" key={item}>
                    <Icon name="check" size={15} />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div id="glossary" className="guide-section">
            <Card title="Glossary" subtitle="Warehouse ke common shabd, simple bhasha mein.">
              <table className="guide-glossary">
                <tbody>
                  {guide.glossary.map((entry) => (
                    <tr key={entry.term}>
                      <td>{entry.term}</td>
                      <td className="muted">{entry.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
