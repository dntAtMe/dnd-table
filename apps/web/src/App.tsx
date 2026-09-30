import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AuthProvider, RequireAuth } from './lib/auth';
import { Campaign } from './pages/Campaign';
import { Home } from './pages/Home';
import { Table } from './pages/Table';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* The table screen has no account; it pairs with a campaign by code. */}
        <Route path="/table" element={<Table />} />
        <Route
          path="/*"
          element={
            <AuthProvider>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/c/:id" element={<RequireAuth>{(user) => <Campaign user={user} />}</RequireAuth>} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AuthProvider>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
