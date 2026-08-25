import { useEffect, useMemo, useState } from 'react'
import {
  Archive,
  Bell,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Cloud,
  DatabaseBackup,
  Download,
  Files,
  FileText,
  Filter,
  FolderKanban,
  Inbox,
  KanbanSquare,
  LayoutDashboard,
  LogOut,
  LockKeyhole,
  MailPlus,
  MessageSquareText,
  Mic,
  Menu,
  Paperclip,
  PhoneCall,
  Plus,
  Radio,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Star,
  UploadCloud,
  Users,
  UserPlus,
  Video,
  Workflow,
  X,
} from 'lucide-react'
import './App.css'

const navItems = [
  { id: 'command', label: 'Command', icon: LayoutDashboard },
  { id: 'mail', label: 'Mail', icon: Inbox, badge: 18 },
  { id: 'meetings', label: 'Meetings', icon: CalendarDays },
  { id: 'chat', label: 'Chat', icon: MessageSquareText, badge: 6 },
  { id: 'tasks', label: 'Tasks', icon: KanbanSquare },
  { id: 'files', label: 'Files', icon: Files },
  { id: 'people', label: 'People', icon: Users },
  { id: 'admin', label: 'Admin', icon: Settings },
]

const mailThreads = [
  {
    from: 'Finance Desk',
    subject: 'Vendor payments for site crews',
    preview: 'Three invoices need approval before 2:00 PM today.',
    time: '09:18',
    tag: 'Approval',
    urgent: true,
  },
  {
    from: 'Operations',
    subject: 'Weekly material movement summary',
    preview: 'Steel, cement, and tile stock movements are attached.',
    time: '08:42',
    tag: 'Report',
  },
  {
    from: 'HR',
    subject: 'New leave policy draft',
    preview: 'Please review the internal leave policy before publishing.',
    time: 'Yesterday',
    tag: 'Policy',
  },
]

const meetings = [
  { title: 'Daily Operations Sync', time: '10:00', team: 'Leadership', type: 'Video', status: 'Starting soon' },
  { title: 'Client Handover Review', time: '13:30', team: 'Projects', type: 'Room A', status: 'Agenda ready' },
  { title: 'Procurement Checkpoint', time: '16:00', team: 'Finance', type: 'Audio', status: 'Waiting for notes' },
]

const chatRooms = [
  { name: '# operations-war-room', last: 'Site B needs the revised schedule before noon.', count: 12 },
  { name: '# finance-approvals', last: 'Approved the supplier advance. Please archive it.', count: 4 },
  { name: '# hr-and-admin', last: 'Two onboarding forms are ready for review.', count: 2 },
]

const taskColumns = [
  {
    title: 'Today',
    tasks: ['Approve supplier payment', 'Confirm boardroom booking', 'Send client progress note'],
  },
  {
    title: 'Waiting',
    tasks: ['Legal review on service agreement', 'Director signature for purchase order'],
  },
  {
    title: 'Done',
    tasks: ['Morning attendance check', 'Weekly backup verification'],
  },
]

const files = [
  { name: 'Board Pack - August', owner: 'CEO Office', type: 'PDF', access: 'Leadership' },
  { name: 'Site Procurement Tracker', owner: 'Operations', type: 'Sheet', access: 'Finance + Ops' },
  { name: 'Employee Handbook', owner: 'HR', type: 'Doc', access: 'All staff' },
]

const people = [
  { name: 'Nadeesha Perera', role: 'Operations Lead', status: 'Available' },
  { name: 'Ravindu Silva', role: 'Finance Manager', status: 'In a meeting' },
  { name: 'Amani Jayawardena', role: 'HR Coordinator', status: 'Available' },
  { name: 'Tharindu Fernando', role: 'Project Manager', status: 'On site' },
]

const approvals = [
  { item: 'Supplier advance - Alumex Lanka', owner: 'Finance', amount: 'LKR 485,000', stage: 'Director approval' },
  { item: 'Overtime request - Site B', owner: 'Operations', amount: '18 staff hours', stage: 'HR verification' },
  { item: 'Laptop purchase - Design team', owner: 'IT', amount: '3 devices', stage: 'Budget check' },
]

const announcements = [
  { title: 'Office network maintenance', date: 'Today 18:30', scope: 'All staff' },
  { title: 'New procurement approval rule', date: 'Tomorrow', scope: 'Finance + Ops' },
  { title: 'Quarterly town hall', date: 'Friday 15:00', scope: 'Company' },
]

const projects = [
  { name: 'GKUC client portal', health: 'On track', lead: 'Product', next: 'Final content approval' },
  { name: 'Internal payroll migration', health: 'Watch', lead: 'Finance', next: 'Bank file testing' },
  { name: 'Warehouse stock audit', health: 'On track', lead: 'Operations', next: 'Cycle count upload' },
]

const adminRules = [
  'Two-step sign-in required for finance and directors',
  'Auto-backup every night at 01:00',
  'Archive mail and chats after 7 years',
  'External sharing disabled unless approved',
]

type AccessLevel = 'Administrator' | 'Manager' | 'Staff'
type PortalUser = {
  id: string
  name: string
  email: string
  password: string
  accessLevel: AccessLevel
  modules: string[]
  active: boolean
}

const companyDomain = 'infinity.lk'
const defaultAdmin: PortalUser = {
  id: 'admin-1',
  name: 'Infinity Administrator',
  email: `admin@${companyDomain}`,
  password: 'Admin@2026',
  accessLevel: 'Administrator',
  modules: navItems.map((item) => item.id),
  active: true,
}

function loadUsers(): PortalUser[] {
  try {
    const saved = localStorage.getItem('infinity-portal-users')
    return saved ? JSON.parse(saved) as PortalUser[] : [defaultAdmin]
  } catch {
    return [defaultAdmin]
  }
}

function App() {
  const [users, setUsers] = useState<PortalUser[]>(loadUsers)
  const [currentUser, setCurrentUser] = useState<PortalUser | null>(() => {
    const savedId = sessionStorage.getItem('infinity-current-user')
    return loadUsers().find((user) => user.id === savedId && user.active) ?? defaultAdmin
  })
  const [active, setActive] = useState('command')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [composeOpen, setComposeOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const allowedNavItems = useMemo(() => navItems.filter((item) => currentUser?.modules.includes(item.id)), [currentUser])
  const ActiveIcon = useMemo(() => navItems.find((item) => item.id === active)?.icon ?? LayoutDashboard, [active])

  const notify = (message: string) => setNotice(message)

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 2600)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    localStorage.setItem('infinity-portal-users', JSON.stringify(users))
  }, [users])

  useEffect(() => {
    if (currentUser) sessionStorage.setItem('infinity-current-user', currentUser.id)
    else sessionStorage.removeItem('infinity-current-user')
  }, [currentUser])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setComposeOpen(false)
        setMobileNavOpen(false)
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('.search-box input')?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const changeView = (id: string) => {
    setActive(id)
    setMobileNavOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const signIn = (email: string, password: string) => {
    const account = users.find((user) => user.email.toLowerCase() === email.trim().toLowerCase() && user.password === password)
    if (!account) return 'The email or password is incorrect.'
    if (!account.active) return 'This account has been suspended. Contact an administrator.'
    setCurrentUser(account)
    setActive(account.modules.includes('command') ? 'command' : account.modules[0] ?? 'command')
    return ''
  }

  if (!currentUser) return <LoginScreen onSignIn={signIn} />

  return (
    <main className="workspace-shell">
      <aside className={mobileNavOpen ? 'sidebar open' : 'sidebar'} aria-label="Infinity Workspace navigation">
        <div className="brand-lockup">
          <div className="brand-mark">I</div>
          <div>
            <strong>Infinity Workspace</strong>
            <span>Internal operations</span>
          </div>
        </div>

        <button className="compose-button" type="button" onClick={() => setComposeOpen(true)}>
          <MailPlus size={18} />
          New message
        </button>

        <nav className="nav-list">
          {allowedNavItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                className={active === item.id ? 'nav-item active' : 'nav-item'}
                key={item.id}
                onClick={() => changeView(item.id)}
                type="button"
                aria-current={active === item.id ? 'page' : undefined}
                title={item.label}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {item.badge ? <small>{item.badge}</small> : null}
              </button>
            )
          })}
        </nav>

        <div className="security-panel">
          <ShieldCheck size={18} />
          <div>
            <strong>Private company cloud</strong>
            <span>Roles, audit logs, backups</span>
          </div>
        </div>
      </aside>

      <section className="main-stage">
        <header className="topbar">
          <button className="mobile-menu" type="button" onClick={() => setMobileNavOpen((value) => !value)} aria-label="Toggle navigation" aria-expanded={mobileNavOpen}>
            {mobileNavOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="page-title">
            <ActiveIcon size={23} />
            <div>
              <span>Company OS</span>
              <h1>{navItems.find((item) => item.id === active)?.label}</h1>
            </div>
          </div>

          <label className="search-box">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search mail, meetings, people, files..." aria-label="Search workspace" />
            {query ? <button className="clear-search" type="button" onClick={() => setQuery('')} aria-label="Clear search"><X size={15} /></button> : <kbd>⌘K</kbd>}
          </label>

          <div className="topbar-actions">
            <button type="button" aria-label="Notifications" onClick={() => notify('You are all caught up')}>
              <Bell size={18} />
            </button>
            <button type="button" aria-label="Start call" onClick={() => { setActive('meetings'); notify('Meeting room opened') }}>
              <Video size={18} />
            </button>
            <button className="profile-button" type="button" onClick={() => { setCurrentUser(null); setMobileNavOpen(false) }} title="Sign out" aria-label={`Sign out ${currentUser.name}`}>
              <span className="avatar">{currentUser.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
              <LogOut size={16} />
            </button>
          </div>
        </header>

        <WorkspaceView active={active} query={query} notify={notify} openCompose={() => setComposeOpen(true)} users={users} setUsers={setUsers} currentUser={currentUser} />
      </section>
      {composeOpen ? <ComposeDialog onClose={() => setComposeOpen(false)} onSend={() => { setComposeOpen(false); notify('Message sent') }} /> : null}
      <div className={notice ? 'toast visible' : 'toast'} role="status" aria-live="polite"><CheckCircle2 size={17} />{notice}</div>
    </main>
  )
}

type ViewProps = {
  query: string
  notify: (message: string) => void
  openCompose: () => void
  users: PortalUser[]
  setUsers: React.Dispatch<React.SetStateAction<PortalUser[]>>
  currentUser: PortalUser
}

function WorkspaceView({ active, ...props }: ViewProps & { active: string }) {
  if (active === 'mail') return <MailView {...props} />
  if (active === 'meetings') return <MeetingsView {...props} />
  if (active === 'chat') return <ChatView {...props} />
  if (active === 'tasks') return <TasksView {...props} />
  if (active === 'files') return <FilesView {...props} />
  if (active === 'people') return <PeopleView {...props} />
  if (active === 'admin') return <AdminView {...props} />
  return <Dashboard notify={props.notify} openCompose={props.openCompose} />
}

function Dashboard({ notify, openCompose }: Pick<ViewProps, 'notify' | 'openCompose'>) {
  return (
    <div className="dashboard-grid">
      <section className="overview-band">
        <div>
          <span className="eyebrow">Today at a glance</span>
          <h2>Run email, meetings, chat, tasks, files, and staff coordination from one internal system.</h2>
        </div>
        <div className="metric-row">
          <Metric label="Open approvals" value="11" tone="amber" />
          <Metric label="Meetings today" value="7" tone="blue" />
          <Metric label="Unread chats" value="24" tone="green" />
          <Metric label="Risk alerts" value="2" tone="red" />
        </div>
      </section>

      <section className="panel mail-panel">
        <PanelHeader icon={Inbox} title="Priority Mail" action="Compose" onAction={openCompose} />
        <div className="thread-list">
          {mailThreads.map((thread) => (
            <article className={thread.urgent ? 'thread urgent' : 'thread'} key={thread.subject}>
              <div className="thread-avatar">{thread.from.slice(0, 2)}</div>
              <div>
                <div className="thread-meta">
                  <strong>{thread.from}</strong>
                  <span>{thread.time}</span>
                </div>
                <h3>{thread.subject}</h3>
                <p>{thread.preview}</p>
                <small>{thread.tag}</small>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <PanelHeader icon={CalendarDays} title="Meetings" action="Schedule" onAction={() => notify('New meeting form ready')} />
        <div className="meeting-list">
          {meetings.map((meeting) => (
            <article className="meeting" key={meeting.title}>
              <time>{meeting.time}</time>
              <div>
                <strong>{meeting.title}</strong>
                <span>{meeting.team} · {meeting.type}</span>
              </div>
              <small>{meeting.status}</small>
            </article>
          ))}
        </div>
        <div className="meeting-actions">
          <button type="button" onClick={() => notify('Video room started')}><Video size={16} /> Start video room</button>
          <button type="button" onClick={() => notify('Audio bridge started')}><Mic size={16} /> Audio bridge</button>
        </div>
      </section>

      <section className="panel chat-panel">
        <PanelHeader icon={MessageSquareText} title="Team Chat" action="New room" onAction={() => notify('New room created')} />
        {chatRooms.map((room) => (
          <article className="chat-room" key={room.name}>
            <div>
              <strong>{room.name}</strong>
              <p>{room.last}</p>
            </div>
            <span>{room.count}</span>
          </article>
        ))}
        <div className="message-draft">
          <input placeholder="Message # operations-war-room" />
          <button type="button" aria-label="Send message" onClick={() => notify('Message sent')}><Send size={17} /></button>
        </div>
      </section>

      <section className="panel task-panel">
        <PanelHeader icon={KanbanSquare} title="Work Board" action="Add task" onAction={() => notify('Task added to Today')} />
        <div className="task-board">
          {taskColumns.map((column) => (
            <div className="task-column" key={column.title}>
              <h3>{column.title}</h3>
              {column.tasks.map((task) => (
                <button type="button" key={task}>
                  <CheckCircle2 size={16} />
                  {task}
                </button>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="panel files-panel">
        <PanelHeader icon={Files} title="Company Files" action="Upload" onAction={() => notify('File picker ready')} />
        {files.map((file) => (
          <article className="file-row" key={file.name}>
            <Paperclip size={17} />
            <div>
              <strong>{file.name}</strong>
              <span>{file.owner} · {file.access}</span>
            </div>
            <small>{file.type}</small>
          </article>
        ))}
      </section>

      <section className="panel people-panel">
        <PanelHeader icon={Users} title="People Directory" action="Invite" onAction={() => notify('Staff invitation ready')} />
        {people.map((person) => (
          <article className="person-row" key={person.name}>
            <div className="person-avatar">{person.name.split(' ').map((part) => part[0]).join('')}</div>
            <div>
              <strong>{person.name}</strong>
              <span>{person.role}</span>
            </div>
            <small>{person.status}</small>
          </article>
        ))}
      </section>

      <section className="operations-strip">
        <Operation icon={Archive} title="Retention" text="Mail, chat, and files kept by company policy." />
        <Operation icon={LockKeyhole} title="Access Control" text="Admin-managed teams, roles, and confidential spaces." />
        <Operation icon={PhoneCall} title="Communication" text="Internal calling layer ready for video provider integration." />
        <Operation icon={BriefcaseBusiness} title="Operations" text="Approvals, tasks, meetings, and documents tracked together." />
      </section>

      <section className="panel approval-panel">
        <PanelHeader icon={ClipboardCheck} title="Approvals Queue" action="Route" onAction={() => notify('Approvals routed')} />
        {approvals.map((approval) => (
          <article className="approval-row" key={approval.item}>
            <div>
              <strong>{approval.item}</strong>
              <span>{approval.owner} · {approval.stage}</span>
            </div>
            <small>{approval.amount}</small>
          </article>
        ))}
      </section>

      <section className="panel broadcast-panel">
        <PanelHeader icon={Radio} title="Company Broadcasts" action="Post" onAction={() => notify('Broadcast composer ready')} />
        {announcements.map((announcement) => (
          <article className="broadcast-row" key={announcement.title}>
            <strong>{announcement.title}</strong>
            <span>{announcement.date} · {announcement.scope}</span>
          </article>
        ))}
      </section>
    </div>
  )
}

function MailView({ query, notify, openCompose }: ViewProps) {
  const allMail = mailThreads.concat([
    { from: 'IT Support', subject: 'Password reset audit', preview: 'Unusual login review completed for three accounts.', time: 'Mon', tag: 'Security' },
    { from: 'CEO Office', subject: 'Friday leadership memo', preview: 'Collect project highlights and blockers by Thursday evening.', time: 'Mon', tag: 'Leadership' },
  ])
  const [selected, setSelected] = useState(allMail[0])
  const visibleMail = allMail.filter((thread) => `${thread.from} ${thread.subject} ${thread.preview}`.toLowerCase().includes(query.toLowerCase()))
  return (
    <div className="module-layout mail-module">
      <section className="module-rail">
        <button className="rail-action" type="button" onClick={openCompose}><MailPlus size={17} /> Compose</button>
        {['Inbox', 'Sent', 'Drafts', 'Approvals', 'Archived', 'Policies'].map((item, index) => (
          <button className={index === 0 ? 'rail-link active' : 'rail-link'} type="button" key={item}>{item}<span>{index === 0 ? '18' : ''}</span></button>
        ))}
      </section>
      <section className="module-list">
        <div className="module-toolbar">
          <button type="button" onClick={() => notify('Showing priority messages')}><Filter size={16} /> Filter</button>
          <button type="button" onClick={() => notify('Message archived')}><Archive size={16} /> Archive</button>
          <button type="button" onClick={() => notify('Message marked complete')}><Check size={16} /> Mark done</button>
        </div>
        {visibleMail.map((thread) => <MailCard thread={thread} selected={selected.subject === thread.subject} onSelect={() => setSelected(thread)} key={thread.subject} />)}
        {!visibleMail.length ? <EmptyState text="No mail matches your search." /> : null}
      </section>
      <section className="reading-pane">
        <span className="eyebrow">Selected Message</span>
        <h2>{selected.subject}</h2>
        <p>{selected.preview}</p>
        <div className="attachment-grid">
          <button type="button"><FileText size={17} /> Invoice bundle.pdf</button>
          <button type="button"><FolderKanban size={17} /> PO-1824</button>
        </div>
        <textarea placeholder="Write a reply or internal note..." />
        <div className="pane-actions">
          <button type="button" onClick={() => notify('Reply sent')}><Send size={16} /> Reply</button>
          <button type="button" onClick={() => notify('Sent for approval')}><Workflow size={16} /> Send for approval</button>
        </div>
      </section>
    </div>
  )
}

function MeetingsView({ notify }: ViewProps) {
  const [muted, setMuted] = useState(false)
  const [cameraOn, setCameraOn] = useState(true)
  return (
    <div className="module-layout meetings-module">
      <section className="calendar-board">
        <PanelHeader icon={CalendarDays} title="Company Calendar" action="New event" onAction={() => notify('New event form ready')} />
        <div className="calendar-grid">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((day) => (
            <article key={day}>
              <strong>{day}</strong>
              <span>{day === 'Wed' ? '5 bookings' : '3 bookings'}</span>
              <button type="button" onClick={() => notify(`${day} room reserved`)}>Reserve room</button>
            </article>
          ))}
        </div>
      </section>
      <section className="panel live-room">
        <PanelHeader icon={Video} title="Live Meeting Room" action="Invite" onAction={() => notify('Meeting invite copied')} />
        <div className="video-stage">
          <div className="video-tile primary">NP</div>
          <div className="video-tile">RS</div>
          <div className="video-tile">AJ</div>
          <div className="video-tile">TF</div>
        </div>
        <div className="meeting-actions">
          <button className={muted ? 'control-off' : ''} type="button" onClick={() => setMuted((value) => !value)}><Mic size={16} /> {muted ? 'Unmute' : 'Mute'}</button>
          <button className={!cameraOn ? 'control-off' : ''} type="button" onClick={() => setCameraOn((value) => !value)}><Video size={16} /> Camera {cameraOn ? 'on' : 'off'}</button>
        </div>
      </section>
      <section className="panel agenda-panel">
        <PanelHeader icon={ClipboardCheck} title="Agenda Builder" action="Publish" onAction={() => notify('Agenda published')} />
        {meetings.map((meeting) => (
          <article className="agenda-item" key={meeting.title}>
            <strong>{meeting.title}</strong>
            <span>{meeting.time} · {meeting.status}</span>
          </article>
        ))}
      </section>
    </div>
  )
}

function ChatView({ notify }: ViewProps) {
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState(['Site B schedule is ready for director review.', 'Please attach supplier delivery note.', 'Done. Added to project files and linked here.', 'Client handover photos uploaded.'])
  const sendMessage = () => {
    if (!draft.trim()) return
    setMessages((items) => [...items, draft.trim()])
    setDraft('')
    notify('Message sent')
  }
  return (
    <div className="module-layout chat-module">
      <section className="module-rail">
        <button className="rail-action" type="button"><Plus size={17} /> New room</button>
        {chatRooms.map((room) => (
          <button className="rail-link" type="button" key={room.name}>{room.name}<span>{room.count}</span></button>
        ))}
      </section>
      <section className="conversation-pane">
        <PanelHeader icon={MessageSquareText} title="# operations-war-room" action="Pin" onAction={() => notify('Room pinned')} />
        {messages.map((message, index) => (
          <article className={index % 2 ? 'bubble mine' : 'bubble'} key={message}>{message}</article>
        ))}
        <div className="message-draft wide">
          <input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') sendMessage() }} placeholder="Write a message, upload file, or start approval..." />
          <button type="button" aria-label="Send message" onClick={sendMessage} disabled={!draft.trim()}><Send size={17} /></button>
        </div>
      </section>
      <section className="panel presence-panel">
        <PanelHeader icon={Users} title="Room Members" action="Add" onAction={() => notify('Member picker ready')} />
        {people.slice(0, 4).map((person) => (
          <article className="person-row" key={person.name}>
            <div className="person-avatar">{person.name.split(' ').map((part) => part[0]).join('')}</div>
            <div><strong>{person.name}</strong><span>{person.status}</span></div>
          </article>
        ))}
      </section>
    </div>
  )
}

function TasksView({ notify }: ViewProps) {
  const [completed, setCompleted] = useState<string[]>([])
  return (
    <div className="module-layout tasks-module">
      <section className="work-map">
        <PanelHeader icon={KanbanSquare} title="Company Work Board" action="New task" onAction={() => notify('New task added')} />
        <div className="task-board expanded">
          {taskColumns.map((column) => (
            <div className="task-column" key={column.title}>
              <h3>{column.title}</h3>
              {column.tasks.concat(column.title === 'Today' ? ['Update internal policy hub'] : []).map((task) => (
                <button className={completed.includes(task) ? 'task-complete' : ''} type="button" onClick={() => setCompleted((items) => items.includes(task) ? items.filter((item) => item !== task) : [...items, task])} key={task}><CheckCircle2 size={16} />{task}</button>
              ))}
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <PanelHeader icon={BriefcaseBusiness} title="Project Spaces" action="Open" onAction={() => notify('Project space opened')} />
        {projects.map((project) => (
          <article className="project-row" key={project.name}>
            <strong>{project.name}</strong>
            <span>{project.lead} · {project.next}</span>
            <small>{project.health}</small>
          </article>
        ))}
      </section>
    </div>
  )
}

function FilesView({ notify }: ViewProps) {
  return (
    <div className="module-layout files-module">
      <section className="file-vault">
        <PanelHeader icon={Cloud} title="Company File Vault" action="Upload" onAction={() => notify('File picker ready')} />
        <div className="vault-actions">
          <button type="button" onClick={() => notify('File picker ready')}><UploadCloud size={18} /> Upload document</button>
          <button type="button" onClick={() => notify('Archive export prepared')}><Download size={18} /> Export archive</button>
          <button type="button" onClick={() => notify('Access manager opened')}><LockKeyhole size={18} /> Manage access</button>
        </div>
        {files.concat([
          { name: 'Director Approval Matrix', owner: 'Admin', type: 'Doc', access: 'Leadership' },
          { name: 'Client Handover Template', owner: 'Projects', type: 'Template', access: 'All staff' },
        ]).map((file) => (
          <article className="file-row large" key={file.name}>
            <Paperclip size={18} />
            <div><strong>{file.name}</strong><span>{file.owner} · {file.access}</span></div>
            <small>{file.type}</small>
          </article>
        ))}
      </section>
      <section className="panel">
        <PanelHeader icon={DatabaseBackup} title="Storage Health" action="Backup" onAction={() => notify('Backup started')} />
        <Metric label="Used storage" value="42%" tone="blue" />
        <Metric label="External shares" value="0" tone="green" />
      </section>
    </div>
  )
}

function PeopleView({ query, notify }: ViewProps) {
  const allPeople = people.concat([
    { name: 'Dinuka Senanayake', role: 'IT Administrator', status: 'Available' },
    { name: 'Harini Wijesinghe', role: 'Legal Counsel', status: 'Away' },
  ]).filter((person) => `${person.name} ${person.role} ${person.status}`.toLowerCase().includes(query.toLowerCase()))
  return (
    <div className="module-layout people-module">
      <section className="directory-table">
        <PanelHeader icon={Users} title="Staff Directory" action="Invite staff" onAction={() => notify('Staff invitation ready')} />
        {allPeople.map((person) => (
          <article className="person-row large" key={person.name}>
            <div className="person-avatar">{person.name.split(' ').map((part) => part[0]).join('')}</div>
            <div><strong>{person.name}</strong><span>{person.role}</span></div>
            <small>{person.status}</small>
          </article>
        ))}
        {!allPeople.length ? <EmptyState text="No staff member matches your search." /> : null}
      </section>
      <section className="panel org-panel">
        <PanelHeader icon={BriefcaseBusiness} title="Departments" action="Edit" onAction={() => notify('Department editor opened')} />
        {['Leadership', 'Finance', 'Operations', 'Projects', 'HR', 'IT'].map((team) => (
          <button type="button" key={team}>{team}<ChevronRight size={16} /></button>
        ))}
      </section>
    </div>
  )
}

function AdminView({ notify, users, setUsers, currentUser }: ViewProps) {
  const [enabledRules, setEnabledRules] = useState(adminRules)
  const [createOpen, setCreateOpen] = useState(false)
  const updateAccount = (id: string, active: boolean) => {
    setUsers((items) => items.map((user) => user.id === id ? { ...user, active } : user))
    notify(active ? 'User account activated' : 'User account suspended')
  }
  return (
    <div className="module-layout admin-module">
      <section className="admin-console user-management">
        <PanelHeader icon={Users} title="Portal Users" action="Create user" onAction={() => setCreateOpen(true)} />
        <div className="user-summary">
          <Metric label="Active accounts" value={String(users.filter((user) => user.active).length)} tone="green" />
          <Metric label="Administrators" value={String(users.filter((user) => user.accessLevel === 'Administrator').length)} tone="blue" />
          <Metric label="Company domain" value={`@${companyDomain}`} tone="amber" />
        </div>
        <div className="account-table" role="table" aria-label="Portal user accounts">
          <div className="account-row account-heading" role="row"><span>User</span><span>Access</span><span>Modules</span><span>Status</span></div>
          {users.map((user) => (
            <article className="account-row" role="row" key={user.id}>
              <div className="account-person"><div className="person-avatar">{user.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</div><div><strong>{user.name}</strong><span>{user.email}</span></div></div>
              <strong>{user.accessLevel}</strong>
              <span>{user.modules.length === navItems.length ? 'All modules' : `${user.modules.length} modules`}</span>
              <button className={user.active ? 'status-active' : 'status-suspended'} type="button" disabled={user.id === currentUser.id} onClick={() => updateAccount(user.id, !user.active)}>{user.active ? 'Active' : 'Suspended'}</button>
            </article>
          ))}
        </div>
      </section>
      <section className="admin-console">
        <PanelHeader icon={Settings} title="Workspace Admin Console" action="Save rules" onAction={() => notify('Security rules saved')} />
        <div className="admin-grid">
          {adminRules.map((rule) => (
            <article key={rule}><ShieldCheck size={18} /><span>{rule}</span><button className={enabledRules.includes(rule) ? 'rule-enabled' : ''} type="button" onClick={() => setEnabledRules((items) => items.includes(rule) ? items.filter((item) => item !== rule) : [...items, rule])}>{enabledRules.includes(rule) ? 'Enabled' : 'Disabled'}</button></article>
          ))}
        </div>
      </section>
      <section className="panel audit-panel">
        <PanelHeader icon={Archive} title="Audit Trail" action="Export" onAction={() => notify('Audit report exported')} />
        {['Finance approved invoice bundle', 'IT enabled two-step sign-in for HR', 'Operations uploaded site handover photos', 'Admin revoked public file link'].map((log) => (
          <article className="audit-row" key={log}>{log}<span>Just now</span></article>
        ))}
      </section>
      {createOpen ? <CreateUserDialog users={users} onClose={() => setCreateOpen(false)} onCreate={(user) => { setUsers((items) => [...items, user]); setCreateOpen(false); notify(`Account created for ${user.email}`) }} /> : null}
    </div>
  )
}

function LoginScreen({ onSignIn }: { onSignIn: (email: string, password: string) => string }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setError(onSignIn(email, password))
  }
  return (
    <main className="login-shell">
      <section className="login-brand">
        <div className="brand-mark">I</div>
        <div><strong>Infinity Workspace</strong><span>Secure company portal</span></div>
      </section>
      <form className="login-panel" onSubmit={submit}>
        <div className="login-heading"><ShieldCheck size={24} /><div><span className="eyebrow">Company account</span><h1>Sign in to your workspace</h1></div></div>
        <p>Use the company email and temporary password provided by your administrator.</p>
        <label>Company email<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={`name@${companyDomain}`} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" required /></label>
        {error ? <div className="login-error" role="alert">{error}</div> : null}
        <button className="login-submit" type="submit"><LockKeyhole size={17} /> Sign in</button>
        <small>Contact your workspace administrator if you cannot access your account.</small>
      </form>
    </main>
  )
}

function CreateUserDialog({ users, onClose, onCreate }: { users: PortalUser[]; onClose: () => void; onCreate: (user: PortalUser) => void }) {
  const [name, setName] = useState('')
  const [localPart, setLocalPart] = useState('')
  const [password, setPassword] = useState('')
  const [accessLevel, setAccessLevel] = useState<AccessLevel>('Staff')
  const [modules, setModules] = useState(['command', 'mail', 'meetings', 'chat', 'tasks', 'files', 'people'])
  const email = `${localPart.trim().toLowerCase()}@${companyDomain}`
  const localPartValid = /^[a-z0-9][a-z0-9._-]{1,62}$/.test(localPart.trim().toLowerCase())
  const passwordValid = password.length >= 8 && /[A-Z]/.test(password) && /\d/.test(password)
  const duplicate = users.some((user) => user.email.toLowerCase() === email)
  const canCreate = name.trim().length >= 2 && localPartValid && passwordValid && !duplicate && modules.length > 0
  const changeLevel = (level: AccessLevel) => {
    setAccessLevel(level)
    if (level === 'Administrator') setModules(navItems.map((item) => item.id))
    else setModules((items) => items.filter((item) => item !== 'admin'))
  }
  const toggleModule = (id: string) => setModules((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id])
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form className="compose-dialog user-dialog" role="dialog" aria-modal="true" aria-labelledby="create-user-title" onSubmit={(event) => { event.preventDefault(); if (canCreate) onCreate({ id: crypto.randomUUID(), name: name.trim(), email, password, accessLevel, modules, active: true }) }}>
        <div className="dialog-header"><div><span className="eyebrow">Identity and access</span><h2 id="create-user-title">Create portal user</h2></div><button type="button" onClick={onClose} aria-label="Close user form"><X size={19} /></button></div>
        <div className="form-grid"><label>Full name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Employee full name" /></label><label>Access level<select value={accessLevel} onChange={(event) => changeLevel(event.target.value as AccessLevel)}><option>Staff</option><option>Manager</option><option>Administrator</option></select></label></div>
        <label>Company email<div className="email-builder"><input value={localPart} onChange={(event) => setLocalPart(event.target.value.replace(/\s/g, ''))} placeholder="firstname.lastname" /><span>@{companyDomain}</span></div>{duplicate ? <small className="field-error">That email already exists.</small> : null}</label>
        <label>Temporary password<input type="text" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters, one capital and number" /><small>The user should change this after their first secure sign-in.</small></label>
        <fieldset><legend>Portal access</legend><div className="access-options">{navItems.map((item) => { const Icon = item.icon; const locked = item.id === 'admin' && accessLevel !== 'Administrator'; return <label key={item.id}><input type="checkbox" checked={modules.includes(item.id)} disabled={locked} onChange={() => toggleModule(item.id)} /><Icon size={16} /><span>{item.label}</span></label> })}</div></fieldset>
        <div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit" disabled={!canCreate}><UserPlus size={16} /> Create account</button></div>
      </form>
    </div>
  )
}

function MailCard({ thread, selected, onSelect }: { thread: (typeof mailThreads)[number]; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`${thread.urgent ? 'thread urgent' : 'thread'} ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="thread-avatar">{thread.from.slice(0, 2)}</div>
      <div>
        <div className="thread-meta">
          <strong>{thread.from}</strong>
          <span>{thread.time}</span>
        </div>
        <h3>{thread.subject}</h3>
        <p>{thread.preview}</p>
        <small>{thread.tag}</small>
      </div>
    </button>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <article className={`metric ${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </article>
  )
}

function PanelHeader({ icon: Icon, title, action, onAction }: { icon: typeof Inbox; title: string; action: string; onAction?: () => void }) {
  return (
    <div className="panel-header">
      <div>
        <Icon size={18} />
        <h2>{title}</h2>
      </div>
      <button type="button" onClick={onAction}>
        <Plus size={15} />
        {action}
      </button>
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state"><Search size={20} /><span>{text}</span></div>
}

function ComposeDialog({ onClose, onSend }: { onClose: () => void; onSend: () => void }) {
  const [recipient, setRecipient] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const canSend = recipient.trim() && subject.trim() && body.trim()
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="compose-dialog" role="dialog" aria-modal="true" aria-labelledby="compose-title">
        <div className="dialog-header"><div><span className="eyebrow">Internal mail</span><h2 id="compose-title">New message</h2></div><button type="button" onClick={onClose} aria-label="Close compose"><X size={19} /></button></div>
        <label>To<input autoFocus value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="Name, team, or email" /></label>
        <label>Subject<input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Message subject" /></label>
        <label>Message<textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Write your message..." /></label>
        <div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="button" disabled={!canSend} onClick={onSend}><Send size={16} /> Send message</button></div>
      </section>
    </div>
  )
}

function Operation({ icon: Icon, title, text }: { icon: typeof Star; title: string; text: string }) {
  return (
    <article>
      <Icon size={18} />
      <strong>{title}</strong>
      <p>{text}</p>
      <ChevronRight size={17} />
    </article>
  )
}

export default App
