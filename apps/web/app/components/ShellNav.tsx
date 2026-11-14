'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from './icons.tsx';

export type NavGroup = { label?: string; items: Array<{ href: string; label: string; icon: string; count?: number }> };

const isCurrent = (pathname: string, href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

/** Primary navigation. A sidebar on wide screens; behind a Menu button on narrow ones. Presentation only. */
export function ShellNav({ groups, children }: { groups: NavGroup[]; children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [pathname]);
  return <>
    <button type="button" className="menu-toggle" aria-expanded={open} aria-controls="shell-menu" onClick={() => setOpen((v) => !v)}>
      <Icon name={open ? 'close' : 'menu'} /> Menu
    </button>
    <div id="shell-menu" className="shell-menu" data-open={open}>
      <nav aria-label="Primary">
        {groups.map((g, i) => <div key={g.label ?? i}>
          {g.label && <p className="nav-label" id={`nav-${i}`}>{g.label}</p>}
          <ul aria-labelledby={g.label ? `nav-${i}` : undefined}>
            {g.items.map((item) => <li key={item.href}>
              <Link href={item.href} aria-current={isCurrent(pathname, item.href) ? 'page' : undefined}>
                <Icon name={item.icon} />{item.label}
                {item.count ? <span className="count">{item.count}<span className="sr-only"> pending</span></span> : null}
              </Link>
            </li>)}
          </ul>
        </div>)}
      </nav>
      {children}
    </div>
  </>;
}
