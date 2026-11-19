import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Loading } from './components/common';
import { Shell } from './components/Shell';
import { OpenRecordsProvider } from './lib/openRecords';
import { SessionProvider, useSession } from './lib/session';
import { DataSearchPage } from './pages/DataSearchPage';
import { DoctorContactsPage } from './pages/DoctorContactsPage';
import { ExamsPage } from './pages/ExamsPage';
import { FollowUpPage } from './pages/FollowUpPage';
import { ArchivePage } from './pages/ArchivePage';
import { CertificatesPage } from './pages/CertificatesPage';
import { ClinicalEntriesPage } from './pages/ClinicalEntriesPage';
import { DrugHistoryPage, ServiceHistoryPage, TherapyPage } from './pages/HistoryPages';
import { PrescribedDrugsPage, PrescribedServicesPage } from './pages/PrescribedPages';
import { LockScreen, LoginPage } from './pages/LoginPage';
import { MeasurementsPage } from './pages/MeasurementsPage';
import { PatientsPage } from './pages/PatientsPage';
import { PlansPage } from './pages/PlansPage';
import { PrescriptionEditor } from './pages/PrescriptionEditor';
import { PrivacyPage } from './pages/PrivacyPage';
import { RecordPage } from './pages/RecordPage';
import { SchedulePage } from './pages/SchedulePage';
import { ServiceCredentialsPage } from './pages/ServiceCredentialsPage';
import { StudioToolsPage } from './pages/StudioToolsPage';
import { SignQueuePage } from './pages/SignQueuePage';
import { SuppliesPage } from './pages/SuppliesPage';
import { HealthProfilePage } from './pages/HealthProfilePage';
import { TemplateCertificatesPage } from './pages/TemplateCertificatesPage';
import { TherapyForm } from './pages/TherapyForm';
import { TodayPage } from './pages/TodayPage';

/** Le schermate dopo l'accesso. */
function Screens() {
  const { state } = useSession();
  if (state.status === 'loading') return <Loading what="dati della sessione" />;
  if (state.status === 'anonymous') return <LoginPage />;
  if (state.status === 'locked') return <LockScreen />;
  return (
    <OpenRecordsProvider>
      <Shell>
        <Routes>
          <Route path="/" element={<TodayPage />} />
          <Route path="/pazienti" element={<PatientsPage />} />
          <Route path="/pazienti/:id" element={<RecordPage />} />
          <Route path="/pazienti/:id/ricetta" element={<PrescriptionEditor mode="farmaci" />} />
          <Route
            path="/pazienti/:id/specialistica"
            element={<PrescriptionEditor mode="specialistica" />}
          />
          <Route path="/pazienti/:id/esami" element={<ExamsPage />} />
          <Route path="/pazienti/:id/certificati" element={<CertificatesPage />} />
          <Route path="/pazienti/:id/voci" element={<ClinicalEntriesPage />} />
          <Route path="/pazienti/:id/parametri" element={<MeasurementsPage />} />
          <Route path="/pazienti/:id/privacy" element={<PrivacyPage />} />
          <Route path="/pazienti/:id/piani" element={<PlansPage />} />
          <Route path="/pazienti/:id/seguito" element={<FollowUpPage />} />
          <Route path="/pazienti/:id/presidi" element={<SuppliesPage />} />
          <Route path="/pazienti/:id/profilo-sanitario" element={<HealthProfilePage />} />
          <Route path="/pazienti/:id/certificati-modelli" element={<TemplateCertificatesPage />} />
          <Route path="/pazienti/:id/terapie/nuova" element={<TherapyForm />} />
          <Route path="/pazienti/:id/terapie/:therapyId" element={<TherapyPage />} />
          <Route path="/pazienti/:id/terapie/:therapyId/modifica" element={<TherapyForm />} />
          <Route path="/pazienti/:id/schema-orario" element={<SchedulePage />} />
          <Route path="/pazienti/:id/prestazioni" element={<ServiceHistoryPage />} />
          <Route path="/pazienti/:id/farmaci" element={<PrescribedDrugsPage />} />
          <Route path="/pazienti/:id/farmaci/storico" element={<DrugHistoryPage />} />
          <Route path="/pazienti/:id/visite-ed-esami" element={<PrescribedServicesPage />} />
          <Route path="/ricette" element={<SignQueuePage />} />
          <Route path="/banche-dati" element={<DataSearchPage />} />
          <Route path="/archivio" element={<ArchivePage />} />
          <Route path="/profilo/credenziali" element={<ServiceCredentialsPage />} />
          <Route path="/profilo/recapiti" element={<DoctorContactsPage />} />
          <Route path="/strumenti" element={<StudioToolsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </OpenRecordsProvider>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Screens />
      </SessionProvider>
    </BrowserRouter>
  );
}
