import { Route, Routes, Navigate } from "react-router-dom";
import { BottomNav } from "@/components/BottomNav";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { GlobalHealthCheck } from "@/components/GlobalHealthCheck";
import HomePage from "@/pages/HomePage";
import StudyPage from "@/pages/StudyPage";
import WordBookPage from "@/pages/WordBookPage";
import WordDetailPage from "@/pages/WordDetailPage";
import CategoryPage from "@/pages/CategoryPage";
import CategoryWordsPage from "@/pages/CategoryWordsPage";
import CategoryStudyPage from "@/pages/CategoryStudyPage";
import StatsPage from "@/pages/StatsPage";
import SettingsPage from "@/pages/SettingsPage";
import QuizAdminPage from "@/pages/QuizAdminPage";
import QuizReviewPage from "@/pages/QuizReviewPage";
import ExamPage from "@/pages/ExamPage";
import ExamStudyPage from "@/pages/ExamStudyPage";
import ExamResultPage from "@/pages/ExamResultPage";
import QuizPage from "@/pages/QuizPage";
import QuizStudyPage from "@/pages/QuizStudyPage";
import QuizResultPage from "@/pages/QuizResultPage";

/**
 * 应用根组件：统一布局（底部导航 + 路由出口）
 *
 * 错误边界位置：包住整个布局（含底部导航），页面渲染异常时整页切到兜底界面；
 * 健康的检查组件放在边界内部，渲染本身也受保护。
 */
export default function App() {
  return (
    <ErrorBoundary>
      <div className="flex min-h-full flex-col">
        <GlobalHealthCheck />
        <main className="flex-1">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/study" element={<StudyPage />} />
            <Route path="/wordbook" element={<WordBookPage />} />
            <Route path="/wordbook/:id" element={<WordDetailPage />} />
            <Route path="/category" element={<CategoryPage />} />
            <Route path="/category/:groupKey/:sub" element={<CategoryWordsPage />} />
            <Route
              path="/category/:groupKey/:sub/study"
              element={<CategoryStudyPage />}
            />
            <Route path="/stats" element={<StatsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/exam" element={<ExamPage />} />
            <Route path="/exam/study/:trainingId" element={<ExamStudyPage />} />
            <Route path="/exam/result/:trainingId" element={<ExamResultPage />} />
            <Route path="/quiz" element={<QuizPage />} />
            <Route path="/quiz/study/:trainingId" element={<QuizStudyPage />} />
            <Route path="/quiz/result/:trainingId" element={<QuizResultPage />} />
            <Route path="/quiz-admin" element={<QuizAdminPage />} />
            <Route path="/quiz-admin/:id" element={<QuizReviewPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <BottomNav />
      </div>
    </ErrorBoundary>
  );
}
