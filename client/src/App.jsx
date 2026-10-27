import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { ThemeProvider, useTheme } from './context/ThemeContext.jsx';
import { MarketProvider } from './context/MarketContext.jsx';
import { Layout } from './components/Layout.jsx';
import { Skeleton } from './components/ui.jsx';
import AuthPage from './pages/AuthPage.jsx';
import Watchlist from './pages/Watchlist.jsx';

const StockDetail = lazy(() => import('./pages/StockDetail.jsx'));
const Scanner = lazy(() => import('./pages/Scanner.jsx'));
const Options = lazy(() => import('./pages/Options.jsx'));
const Positions = lazy(() => import('./pages/Positions.jsx'));
const Orders = lazy(() => import('./pages/Orders.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Account = lazy(() => import('./pages/Account.jsx'));
const News = lazy(() => import('./pages/News.jsx'));
const Review = lazy(() => import('./pages/Review.jsx'));

function Protected() {
  const { user, token, loading } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  if (loading || !user) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  return (
    <MarketProvider>
      <Layout />
    </MarketProvider>
  );
}

function Toasts() {
  const { theme } = useTheme();
  return <Toaster theme={theme} position="top-center" richColors closeButton duration={3000} />;
}

const PageFallback = () => <Skeleton className="h-64 w-full" />;

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/login" element={<AuthPage mode="login" />} />
              <Route path="/register" element={<AuthPage mode="register" />} />
              <Route element={<Protected />}>
                <Route index element={<Watchlist />} />
                <Route path="scanner" element={<Scanner />} />
                <Route path="stock/:symbol" element={<StockDetail />} />
                <Route path="options" element={<Options />} />
                <Route path="news" element={<News />} />
                <Route path="review" element={<Review />} />
                <Route path="positions" element={<Positions />} />
                <Route path="orders" element={<Orders />} />
                <Route path="dashboard" element={<Dashboard />} />
                <Route path="account" element={<Account />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
        <Toasts />
      </AuthProvider>
    </ThemeProvider>
  );
}
