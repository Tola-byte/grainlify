import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ExternalLink, Copy, CircleDot, ArrowLeft } from 'lucide-react';
import { useTheme } from '../../../shared/contexts/ThemeContext';
import { getPublicProject, getPublicProjectIssues, getPublicProjectPRs } from '../../../shared/api/client';

interface ProjectDetailPageProps {
  onBack?: () => void;
  onIssueClick?: (id: string) => void;
  projectId?: string;
  onClose?: () => void;
}

export function ProjectDetailPage({ onBack, onIssueClick, projectId: propProjectId, onClose }: ProjectDetailPageProps) {
  const { theme } = useTheme();
  const { projectId: paramProjectId } = useParams<{ projectId: string }>();
  const projectId = propProjectId || paramProjectId;
  const [activeIssueTab, setActiveIssueTab] = useState('all');
  const [copiedLink, setCopiedLink] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<null | Awaited<ReturnType<typeof getPublicProject>>>(null);
  const [issues, setIssues] = useState<Array<{
    github_issue_id: number;
    number: number;
    state: string;
    title: string;
    description: string | null;
    author_login: string;
    labels: any[];
    url: string;
    updated_at: string | null;
    last_seen_at: string;
  }>>([]);
  const [prs, setPRs] = useState<Array<{
    github_pr_id: number;
    number: number;
    state: string;
    title: string;
    author_login: string;
    url: string;
    merged: boolean;
    created_at: string | null;
    updated_at: string | null;
    closed_at: string | null;
    merged_at: string | null;
    last_seen_at: string;
  }>>([]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!projectId) return;
      setIsLoading(true);
      setError(null);
      try {
        const [p, i, pr] = await Promise.all([
          getPublicProject(projectId),
          getPublicProjectIssues(projectId),
          getPublicProjectPRs(projectId),
        ]);
        if (cancelled) return;
        setProject(p);
        setIssues(i.issues || []);
        setPRs(pr.prs || []);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load project');
      } finally {
        if (cancelled) return;
        setIsLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const repoName = useMemo(() => {
    const full = project?.github_full_name || '';
    const parts = full.split('/');
    return parts[1] || full || 'Project';
  }, [project?.github_full_name]);

  const ownerLogin = project?.repo?.owner_login || (project?.github_full_name?.split('/')[0] || '');
  const ownerAvatar =
    project?.repo?.owner_avatar_url ||
    (ownerLogin ? `https://github.com/${ownerLogin}.png?size=200` : '');

  const githubUrl = project?.repo?.html_url || (project?.github_full_name ? `https://github.com/${project.github_full_name}` : '');
  const websiteUrl = project?.repo?.homepage || '';
  const description = project?.repo?.description || '';

  const languages = useMemo(() => {
    const list = (project?.languages || [])
      .slice()
      .sort((a, b) => b.percentage - a.percentage)
      .map((l) => ({ name: l.name, percentage: Math.round(l.percentage) }));
    return list.length ? list : (project?.language ? [{ name: project.language, percentage: 100 }] : []);
  }, [project?.languages, project?.language]);

  const labelName = (l: any): string | null => {
    if (!l) return null;
    if (typeof l === 'string') return l;
    if (typeof l?.name === 'string') return l.name;
    return null;
  };

  const issueTabs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of issues) {
      const labels = Array.isArray(it.labels) ? it.labels : [];
      for (const l of labels) {
        const name = labelName(l);
        if (!name) continue;
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
    const top = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, count]) => ({ id: name, label: name, count }));
    return [{ id: 'all', label: 'All issues', count: issues.length }, ...top];
  }, [issues]);

  const filteredIssues = useMemo(() => {
    if (activeIssueTab === 'all') return issues;
    return issues.filter((it) => (Array.isArray(it.labels) ? it.labels : []).some((l) => labelName(l) === activeIssueTab));
  }, [issues, activeIssueTab]);

  const timeAgo = (iso?: string | null) => {
    const s = iso || '';
    const d = s ? new Date(s) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    const diffMs = Date.now() - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  const contributors = useMemo(() => {
    const uniq = new Map<string, { name: string; avatar: string }>();
    for (const it of [...issues, ...prs]) {
      const login = (it as any).author_login;
      if (!login || uniq.has(login)) continue;
      uniq.set(login, { name: login, avatar: `https://github.com/${login}.png?size=80` });
      if (uniq.size >= 6) break;
    }
    return Array.from(uniq.values());
  }, [issues, prs]);

  const recentPRs = useMemo(() => {
    return prs.slice(0, 3).map((p) => ({
      number: String(p.number),
      title: p.title,
      date: (p.updated_at || p.last_seen_at || '').slice(0, 10),
    }));
  }, [prs]);

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  return (
    <div className="flex gap-6 h-full">
      {/* Left Sidebar */}
      <div className="w-[280px] flex-shrink-0 space-y-6">
        {/* Project Logo */}
        <div className={`backdrop-blur-[40px] rounded-[24px] border p-6 transition-colors ${
          theme === 'dark'
            ? 'bg-white/[0.12] border-white/20'
            : 'bg-white/[0.12] border-white/20'
        }`}>
          <div className="aspect-square rounded-[20px] overflow-hidden bg-gradient-to-br from-[#c9983a]/20 to-[#d4af37]/10">
            <img 
              src={ownerAvatar || 'https://github.com/github.png?size=200'} 
              alt={repoName}
              className="w-full h-full object-cover"
            />
          </div>
        </div>

        {/* Community */}
        <div className={`backdrop-blur-[40px] rounded-[24px] border p-6 transition-colors ${
          theme === 'dark'
            ? 'bg-white/[0.12] border-white/20'
            : 'bg-white/[0.12] border-white/20'
        }`}>
          <h3 className={`text-[16px] font-bold mb-4 transition-colors ${
            theme === 'dark' ? 'text-[#f5f5f5]' : 'text-[#2d2820]'
          }`}>Community</h3>
          <div className="flex flex-col gap-2">
            {!!websiteUrl && (
            <a
                href={websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center gap-2 px-4 py-2.5 rounded-[12px] backdrop-blur-[20px] border border-white/25 hover:bg-white/[0.2] transition-all text-[13px] font-semibold ${
                theme === 'dark' ? 'bg-white/[0.08] text-[#f5f5f5]' : 'bg-white/[0.08] text-[#2d2820]'
              }`}
            >
              <ExternalLink className="w-4 h-4" />
              Website
            </a>
            )}
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center gap-2 px-4 py-2.5 rounded-[12px] backdrop-blur-[20px] border border-white/25 hover:bg-white/[0.2] transition-all text-[13px] font-semibold ${
                theme === 'dark' ? 'bg-white/[0.08] text-[#f5f5f5]' : 'bg-white/[0.08] text-[#2d2820]'
              }`}
            >
              <ExternalLink className="w-4 h-4" />
              GitHub
            </a>
          </div>
        </div>

        {/* Languages */}
        <div className={`backdrop-blur-[40px] rounded-[24px] border p-6 transition-colors ${
          theme === 'dark'
            ? 'bg-white/[0.12] border-white/20'
            : 'bg-white/[0.12] border-white/20'
        }`}>
          <h3 className={`text-[16px] font-bold mb-4 transition-colors ${
            theme === 'dark' ? 'text-[#f5f5f5]' : 'text-[#2d2820]'
          }`}>Languages</h3>
          <div className="space-y-3">
            {languages.length ? languages.map((lang, idx) => (
              <div key={idx}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className={`text-[13px] font-semibold transition-colors ${
                    theme === 'dark' ? 'text-[#f5f5f5]' : 'text-[#2d2820]'
                  }`}>{lang.name}</span>
                  <span className="text-[12px] font-bold text-[#c9983a]">{lang.percentage}%</span>
                </div>
                <div className="h-2 rounded-full backdrop-blur-[15px] bg-white/[0.08] border border-white/15 overflow-hidden">
                  <div 
                    className="h-full bg-gradient-to-r from-[#c9983a] to-[#d4af37] rounded-full transition-all duration-500"
                    style={{ width: `${lang.percentage}%` }}
                  />
                </div>
              </div>
            )) : (
              <div className={`text-[13px] ${theme === 'dark' ? 'text-[#d4d4d4]' : 'text-[#7a6b5a]'}`}>
                {isLoading ? 'Loading…' : 'No language data'}
              </div>
            )}
          </div>
        </div>

        {/* Ecosystems */}
        <div className={`backdrop-blur-[40px] rounded-[24px] border p-6 transition-colors ${
          theme === 'dark'
            ? 'bg-white/[0.12] border-white/20'
            : 'bg-white/[0.12] border-white/20'
        }`}>
          <h3 className={`text-[16px] font-bold mb-4 transition-colors ${
            theme === 'dark' ? 'text-[#f5f5f5]' : 'text-[#2d2820]'
          }`}>Ecosystems</h3>
          <div className="flex flex-wrap gap-2">
            {(project?.ecosystem_name ? [project.ecosystem_name] : []).map((eco, idx) => (
              <span
                key={idx}
                className={`px-3 py-1.5 rounded-[8px] text-[12px] font-bold backdrop-blur-[20px] border border-white/25 transition-colors ${
                  theme === 'dark' ? 'bg-white/[0.08] text-[#f5f5f5]' : 'bg-white/[0.08] text-[#2d2820]'
                }`}
              >
                {eco}
              </span>
            ))}
          </div>
        </div>

        {/* Categories */}
        <div className={`backdrop-blur-[40px] rounded-[24px] border p-6 transition-colors ${
          theme === 'dark'
            ? 'bg-white/[0.12] border-white/20'
            : 'bg-white/[0.12] border-white/20'
        }`}>
          <h3 className={`text-[16px] font-bold mb-4 transition-colors ${
            theme === 'dark' ? 'text-[#f5f5f5]' : 'text-[#2d2820]'
          }`}>Categories</h3>
          <div className="flex flex-wrap gap-2">
            {(project?.category ? [project.category] : []).map((cat, idx) => (
              <span
                key={idx}
                className={`px-3 py-1.5 rounded-[8px] text-[12px] font-bold backdrop-blur-[20px] border border-white/25 transition-colors ${
                  theme === 'dark' ? 'bg-white/[0.08] text-[#f5f5f5]' : 'bg-white/[0.08] text-[#2d2820]'
                }`}
              >
                {cat}
              </span>
            ))}
          </div>
        </div>

        {/* Owner */}
        <div className={`backdrop-blur-[40px] rounded-[24px] border p-6 transition-colors ${
          theme === 'dark'
            ? 'bg-white/[0.12] border-white/20'
            : 'bg-white/[0.12] border-white/20'
        }`}>
          <h3 className={`text-[16px] font-bold mb-4 transition-colors ${
            theme === 'dark' ? 'text-[#f5f5f5]' : 'text-[#2d2820]'
          }`}>Owner</h3>
          <div className="space-y-3">
            {ownerLogin ? (
              <div className="flex items-center gap-3">
                <img 
                  src={ownerAvatar} 
                  alt={ownerLogin}
                  className="w-8 h-8 rounded-full border-2 border-[#c9983a]/30"
                />
                <span className={`text-[13px] font-semibold transition-colors ${
                  theme === 'dark' ? 'text-[#f5f5f5]' : 'text-[#2d2820]'
                }`}>{ownerLogin}</span>
              </div>
            ) : (
              <div className={`text-[13px] ${theme === 'dark' ? 'text-[#d4d4d4]' : 'text-[#7a6b5a]'}`}>
                {isLoading ? 'Loading…' : 'Unknown'}
              </div>
            )}
          </div>
        </div>

        {/* Contributors */}
        <div className={`backdrop-blur-[40px] rounded-[24px] border p-6 transition-colors ${
          theme === 'dark'
            ? 'bg-white/[0.12] border-white/20'
            : 'bg-white/[0.12] border-white/20'
        }`}>
          <h3 className={`text-[16px] font-bold mb-4 transition-colors ${
            theme === 'dark' ? 'text-[#f5f5f5]' : 'text-[#2d2820]'
          }`}>Contributors</h3>
          <div className="flex items-center gap-2 mb-3">
            <div className="flex -space-x-2">
              {contributors.slice(0, 3).map((contributor) => (
                <img 
                  key={contributor.name}
                  src={contributor.avatar} 
                  alt={contributor.name}
                  className="w-8 h-8 rounded-full border-2 border-[#c9983a]/30"
                />
              ))}
            </div>
          </div>
          <p className={`text-[12px] transition-colors ${
            theme === 'dark' ? 'text-[#d4d4d4]' : 'text-[#7a6b5a]'
          }`}>
            {contributors.length
              ? `${contributors.slice(0, 2).map(c => c.name).join(', ')}${project?.contributors_count && project.contributors_count > 2 ? ` and ${project.contributors_count - 2} others` : ''}`
              : (isLoading ? 'Loading…' : 'No contributors yet')}
          </p>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 space-y-6 overflow-y-auto">
        {/* Back Button */}
        {(onBack || onClose) && (
          <button
            onClick={onBack || onClose}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-[12px] backdrop-blur-[40px] border hover:bg-white/[0.2] transition-all ${
              theme === 'dark'
                ? 'bg-white/[0.12] border-white/20 text-[#f5f5f5]'
                : 'bg-white/[0.12] border-white/20 text-[#2d2820]'
            }`}
          >
            <ArrowLeft className="w-5 h-5" />
            <span className="font-semibold text-[14px]">Back to Browse</span>
          </button>
        )}

        {/* Header */}
        <div className={`backdrop-blur-[40px] rounded-[24px] border p-8 transition-colors ${
          theme === 'dark'
            ? 'bg-white/[0.12] border-white/20'
            : 'bg-white/[0.12] border-white/20'
        }`}>
          <div className="flex items-start justify-between mb-4">
            <div>
              <h1 className={`text-[32px] font-bold mb-2 transition-colors ${
                theme === 'dark' ? 'text-[#f5f5f5]' : 'text-[#2d2820]'
              }`}>{repoName}</h1>
              <p className={`text-[15px] transition-colors ${
                theme === 'dark' ? 'text-[#d4d4d4]' : 'text-[#7a6b5a]'
              }`}>{description || project?.github_full_name || ''}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => githubUrl && window.open(githubUrl, '_blank')}
                className={`p-3 rounded-[12px] backdrop-blur-[20px] border border-white/25 hover:bg-white/[0.2] transition-all ${
                  theme === 'dark' ? 'bg-white/[0.08] text-[#f5f5f5]' : 'bg-white/[0.08] text-[#2d2820]'
                }`}
              >
                <ExternalLink className="w-5 h-5" />
              </button>
              <button
                onClick={handleCopyLink}
                className={`p-3 rounded-[12px] backdrop-blur-[20px] border border-white/25 hover:bg-white/[0.2] transition-all ${
                  theme === 'dark' ? 'bg-white/[0.08] text-[#f5f5f5]' : 'bg-white/[0.08] text-[#2d2820]'
                }`}
              >
                <Copy className={`w-5 h-5 ${copiedLink ? 'text-[#c9983a]' : ''}`} />
              </button>
              <button className="px-6 py-3 rounded-[14px] bg-gradient-to-br from-[#c9983a] to-[#d4af37] text-white font-bold text-[14px] hover:opacity-90 transition-all">
                Contribute now
              </button>
            </div>
          </div>
          {error && (
            <div className={`mt-4 p-4 rounded-[16px] border ${
              theme === 'dark' ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'bg-red-500/10 border-red-500/30 text-red-600'
            }`}>
              <p className="text-[14px] font-semibold">{error}</p>
            </div>
          )}
        </div>

        {/* Overview */}
        <div className={`backdrop-blur-[40px] rounded-[24px] border p-8 transition-colors ${
          theme === 'dark'
            ? 'bg-white/[0.12] border-white/20'
            : 'bg-white/[0.12] border-white/20'
        }`}>
          <div className="flex items-center justify-between mb-6">
            <h2 className={`text-[18px] font-bold flex items-center gap-2 transition-colors ${
              theme === 'dark' ? 'text-[#f5f5f5]' : 'text-[#2d2820]'
            }`}>
              <span className="text-[#c9983a]">✦</span>
              Overview
            </h2>
          </div>
          <p className={`text-[15px] leading-relaxed transition-colors ${
            theme === 'dark' ? 'text-[#d4d4d4]' : 'text-[#4a3f2f]'
          }`}>
            {description || (isLoading ? 'Loading…' : 'No description available.')}
          </p>
        </div>

        {/* Issues */}
        <div className={`backdrop-blur-[40px] rounded-[24px] border p-8 transition-colors ${
          theme === 'dark'
            ? 'bg-white/[0.12] border-white/20'
            : 'bg-white/[0.12] border-white/20'
        }`}>
          <h2 className={`text-[18px] font-bold mb-6 transition-colors ${
            theme === 'dark' ? 'text-[#f5f5f5]' : 'text-[#2d2820]'
          }`}>Issues</h2>

          {/* Issue Tabs */}
          <div className="flex flex-wrap items-center gap-2 mb-6">
            {issueTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveIssueTab(tab.id)}
                className={`px-4 py-2 rounded-[10px] text-[13px] font-semibold transition-all ${
                  activeIssueTab === tab.id
                    ? 'bg-[#c9983a] text-white'
                    : `backdrop-blur-[20px] border border-white/25 hover:bg-white/[0.2] ${
                        theme === 'dark' ? 'bg-white/[0.08] text-[#f5f5f5]' : 'bg-white/[0.08] text-[#2d2820]'
                      }`
                }`}
              >
                {tab.label} ({tab.count})
              </button>
            ))}
          </div>

          {/* Issue List */}
          <div className="space-y-4">
            {filteredIssues.map((issue) => (
              <div
                key={issue.github_issue_id}
                className={`p-6 rounded-[16px] backdrop-blur-[25px] border border-white/25 hover:bg-white/[0.15] transition-all cursor-pointer ${
                  theme === 'dark' ? 'bg-white/[0.08]' : 'bg-white/[0.08]'
                }`}
                onClick={() => onIssueClick && onIssueClick(String(issue.github_issue_id))}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-start gap-3 flex-1">
                    <CircleDot className="w-5 h-5 text-[#4ade80] flex-shrink-0 mt-0.5" />
                    <h3 className={`text-[15px] font-bold transition-colors ${
                      theme === 'dark' ? 'text-[#f5f5f5]' : 'text-[#2d2820]'
                    }`}>{issue.title}</h3>
                  </div>
                </div>
                <div className="flex items-center justify-between ml-8">
                  <div className="flex items-center gap-2">
                    {(Array.isArray(issue.labels) ? issue.labels : [])
                      .map((l) => labelName(l))
                      .filter(Boolean)
                      .slice(0, 4)
                      .map((tag, idx) => (
                      <span
                        key={idx}
                        className={`px-3 py-1 rounded-[6px] text-[11px] font-bold backdrop-blur-[20px] border border-white/20 transition-colors ${
                          theme === 'dark' ? 'bg-white/[0.1] text-[#d4d4d4]' : 'bg-white/[0.1] text-[#4a3f2f]'
                        }`}
                      >
                        {String(tag)}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-[12px] transition-colors ${
                      theme === 'dark' ? 'text-[#d4d4d4]' : 'text-[#7a6b5a]'
                    }`}>{timeAgo(issue.updated_at || issue.last_seen_at)}</span>
                    <div className="flex items-center gap-2">
                      <img 
                        src={`https://github.com/${issue.author_login}.png?size=40`} 
                        alt={issue.author_login}
                        className="w-5 h-5 rounded-full border border-[#c9983a]/30"
                      />
                      <span className={`text-[12px] font-semibold transition-colors ${
                        theme === 'dark' ? 'text-[#f5f5f5]' : 'text-[#2d2820]'
                      }`}>By {issue.author_login}</span>
                    </div>
                    <span className={`px-2 py-1 rounded-[6px] text-[11px] font-bold backdrop-blur-[20px] border border-white/20 transition-colors ${
                      theme === 'dark' ? 'bg-white/[0.1] text-[#d4d4d4]' : 'bg-white/[0.1] text-[#4a3f2f]'
                    }`}>
                      📦 {repoName}
                    </span>
                  </div>
                </div>
              </div>
            ))}
            {!isLoading && filteredIssues.length === 0 && (
              <div className={`p-6 rounded-[16px] border text-center ${
                theme === 'dark' ? 'bg-white/[0.08] border-white/15 text-[#d4d4d4]' : 'bg-white/[0.15] border-white/25 text-[#7a6b5a]'
              }`}>
                <p className="text-[14px] font-semibold">No issues found</p>
              </div>
            )}
          </div>
        </div>

        {/* Recent Activity */}
        <div className={`backdrop-blur-[40px] rounded-[24px] border p-8 transition-colors ${
          theme === 'dark'
            ? 'bg-white/[0.12] border-white/20'
            : 'bg-white/[0.12] border-white/20'
        }`}>
          <h2 className={`text-[18px] font-bold mb-6 transition-colors ${
            theme === 'dark' ? 'text-[#f5f5f5]' : 'text-[#2d2820]'
          }`}>Recent Activity</h2>
          <div className="space-y-3">
            {recentPRs.map((activity, idx) => (
              <div
                key={idx}
                className={`flex items-center justify-between p-4 rounded-[12px] backdrop-blur-[20px] border border-white/20 hover:bg-white/[0.15] transition-all ${
                  theme === 'dark' ? 'bg-white/[0.05]' : 'bg-white/[0.05]'
                }`}
              >
                <div className="flex items-center gap-3">
                      <div className="px-2 py-1 rounded-[6px] bg-[#4ade80]/20 border border-[#4ade80]/30">
                        <span className="text-[11px] font-bold text-[#4ade80]">#{activity.number}</span>
                      </div>
                      <span className={`text-[14px] font-semibold transition-colors ${
                        theme === 'dark' ? 'text-[#f5f5f5]' : 'text-[#2d2820]'
                      }`}>{activity.title}</span>
                </div>
                <span className={`text-[13px] transition-colors ${
                  theme === 'dark' ? 'text-[#d4d4d4]' : 'text-[#7a6b5a]'
                }`}>{activity.date}</span>
              </div>
            ))}
            {!isLoading && recentPRs.length === 0 && (
              <div className={`p-6 rounded-[16px] border text-center ${
                theme === 'dark' ? 'bg-white/[0.08] border-white/15 text-[#d4d4d4]' : 'bg-white/[0.15] border-white/25 text-[#7a6b5a]'
              }`}>
                <p className="text-[14px] font-semibold">No recent pull requests</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}