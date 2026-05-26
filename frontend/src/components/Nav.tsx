import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';

const links = [
  { to: '/', label: 'Send' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/proxies', label: 'Proxies' },
  { to: '/settings', label: 'Settings' }
];

export function Nav() {
  return (
    <nav className="flex items-center gap-2 px-6 py-3 border-b bg-card">
      {links.map(l => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.to === '/'}
          className={({ isActive }) =>
            cn(
              'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
              isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
            )
          }
        >
          {l.label}
        </NavLink>
      ))}
      <a href="/logout" className="ml-auto px-3 py-1.5 rounded-md text-sm font-medium hover:bg-accent">
        Logout
      </a>
    </nav>
  );
}
