import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { Loading } from './components/common';
import { Shell } from './components/Shell';
import { OpenRecordsProvider } from './lib/openRecords';
import { SessionProvider, useSession } from './lib/session';
import { DataSearchPage } from './pages/DataSearchPage';
import { DoctorContactsPage } from './pages/DoctorContactsPage';
import { ExamsPage } from './pages/ExamsPage';
import { FollowUpPage } from './pages/FollowUpPage';
import { ArchivePage } from './pages/ArchivePage';
import { ReportsPage } from './pages/ReportsPage';
import { CertificatesPage } from './pages/CertificatesPage';
import { ClinicalEntriesPage } from './pages/ClinicalEntriesPage';
import { DrugHistoryPage, ServiceHistoryPage, TherapyPage } from './pages/HistoryPages';
import { PrescribedDrugsPage, PrescribedServicesPage } from './pages/PrescribedPages';
import { IdentityPage } from './pages/IdentityPage';
import { LocksPage } from './pages/LocksPage';
import { RecoveryPage } from './pages/RecoveryPage';
import { LockScreen, LoginPage } from './pages/LoginPage';
import { MeasurementsPage } from './pages/MeasurementsPage';
import { PasswordPage } from './pages/PasswordPage';
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
import { PpipPage } from './pages/PpipPage';
import { PpipReportPage } from './pages/PpipReportPage';
import { HealthProfilePage } from './pages/HealthProfilePage';
import { FseAccessPage } from './pages/FseAccessPage';
import { TemplateCertificatesPage } from './pages/TemplateCertificatesPage';
import { TherapyForm } from './pages/TherapyForm';
import { TodayPage } from './pages/TodayPage';
import { NewPatientPage } from './pages/NewPatientPage';
import { PatientLayout } from './components/PatientLayout';
import { PatientAdminPage } from './pages/PatientAdminPage';

/** Le schermate dopo l'accesso. */
function Screens() {
  const { state } = useSession();
  const { pathname } = useLocation();
  if (state.status === 'loading') return <Loading what="dati della sessione" />;
  // Il ripristino con SPID o CIE (D189) è per chi non riesce a entrare: senza sessione.
  if (state.status === 'anonymous')
    return pathname.startsWith('/ripristino') ? <RecoveryPage /> : <LoginPage />;
  if (state.status === 'locked') return <LockScreen />;
  // Password temporanea (tappa 14): prima di ogni altra schermata, la password nuova.
  if (state.me.devoCambiarePassword) return <PasswordPage forced />;
  return (
    <OpenRecordsProvider>
      <Shell>
        <Routes>
          <Route path="/" element={<TodayPage />} />
          <Route path="/pazienti" element={<PatientsPage />} />
          <Route path="/pazienti/nuovo" element={<NewPatientPage />} />
          {/* La cartella del paziente (D244): fascia fissa, menu delle voci, pagina scelta. */}
          <Route path="/pazienti/:id" element={<PatientLayout />}>
            <Route index element={<RecordPage />} />
            <Route path="amministrazione" element={<PatientAdminPage />} />
            <Route path="ricetta" element={<PrescriptionEditor mode="farmaci" />} />
            <Route path="specialistica" element={<PrescriptionEditor mode="specialistica" />} />
            <Route path="esami" element={<ExamsPage />} />
            <Route path="certificati" element={<CertificatesPage />} />
            <Route path="voci" element={<ClinicalEntriesPage />} />
            <Route path="parametri" element={<MeasurementsPage />} />
            <Route path="privacy" element={<PrivacyPage />} />
            <Route path="piani" element={<PlansPage />} />
            <Route path="seguito" element={<FollowUpPage />} />
            <Route path="presidi" element={<SuppliesPage />} />
            <Route path="prestazioni-aggiuntive" element={<PpipPage />} />
            <Route path="profilo-sanitario" element={<HealthProfilePage />} />
            <Route path="fascicolo-regionale" element={<FseAccessPage />} />
            <Route path="certificati-modelli" element={<TemplateCertificatesPage />} />
            <Route path="terapie/nuova" element={<TherapyForm />} />
            <Route path="terapie/:therapyId" element={<TherapyPage />} />
            <Route path="terapie/:therapyId/modifica" element={<TherapyForm />} />
            <Route path="schema-orario" element={<SchedulePage />} />
            <Route path="prestazioni" element={<ServiceHistoryPage />} />
            <Route path="farmaci" element={<PrescribedDrugsPage />} />
            <Route path="farmaci/storico" element={<DrugHistoryPage />} />
            <Route path="visite-ed-esami" element={<PrescribedServicesPage />} />
          </Route>
          <Route path="/ricette" element={<SignQueuePage />} />
          <Route path="/banche-dati" element={<DataSearchPage />} />
          <Route path="/archivio" element={<ArchivePage />} />
          <Route path="/archivio/riepiloghi" element={<ReportsPage />} />
          <Route path="/archivio/prestazioni-aggiuntive" element={<PpipReportPage />} />
          <Route path="/profilo/credenziali" element={<ServiceCredentialsPage />} />
          <Route path="/profilo/recapiti" element={<DoctorContactsPage />} />
          <Route path="/profilo/password" element={<PasswordPage />} />
          <Route path="/profilo/blocchi" element={<LocksPage />} />
          <Route path="/profilo/identita" element={<IdentityPage />} />
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
