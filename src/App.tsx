import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { NavBar } from "./components/NavBar";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { ChatAssistant } from "./components/ChatAssistant";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ScreenerPage } from "./pages/ScreenerPage";
import { LeaguePage } from "./pages/LeaguePage";

export function App() {
  return (
    <AuthProvider>
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
            path="/league"
            element={
              <ProtectedRoute>
                <LeaguePage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <ChatAssistant />
      </div>
    </AuthProvider>
  );
}
