import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { ChatProvider } from "./context/ChatContext";
import { NavBar } from "./components/NavBar";
import { BottomNav } from "./components/BottomNav";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { ChatAssistant } from "./components/ChatAssistant";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ScreenerPage } from "./pages/ScreenerPage";
import { SocialPage } from "./pages/SocialPage";
import { LeaguePage } from "./pages/LeaguePage";
import { CompetitorDashboardPage } from "./pages/CompetitorDashboardPage";

export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ChatProvider>
          <div className="app-shell">
            <NavBar />
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route
                path="/"
                element={
                  <ProtectedRoute>
                    <DashboardPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/screen"
                element={
                  <ProtectedRoute>
                    <ScreenerPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/screen/:ticker"
                element={
                  <ProtectedRoute>
                    <ScreenerPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/social"
                element={
                  <ProtectedRoute>
                    <SocialPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/league"
                element={
                  <ProtectedRoute>
                    <LeaguePage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/league/competitors/:id"
                element={
                  <ProtectedRoute>
                    <CompetitorDashboardPage />
                  </ProtectedRoute>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            <ChatAssistant />
            <BottomNav />
          </div>
        </ChatProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
