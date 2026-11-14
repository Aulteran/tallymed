import { AuthShell } from './components/AuthShell.tsx';

export const metadata = { title: 'Not found · TallyMed' };

export default function NotFound() {
  return <AuthShell>
    <div className="card">
      <h1>Page not found</h1>
      <p>That page does not exist, or it is no longer available.</p>
      <p className="actions"><a className="button" href="/">Go to the overview</a></p>
    </div>
  </AuthShell>;
}
