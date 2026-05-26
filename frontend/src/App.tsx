import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';
import { Nav } from '@/components/Nav';
import MainPage from '@/pages/MainPage';
import AccountsPage from '@/pages/AccountsPage';
import ProxiesPage from '@/pages/ProxiesPage';
import SettingsPage from '@/pages/SettingsPage';

export default function App() {
  return (
    <BrowserRouter>
      <Nav />
      <Routes>
        <Route path="/" element={<MainPage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/proxies" element={<ProxiesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
      <Toaster richColors position="bottom-right" />
    </BrowserRouter>
  );
}
