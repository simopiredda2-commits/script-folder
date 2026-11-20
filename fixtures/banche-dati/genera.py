"""Genera i file d'esempio delle banche dati pubbliche (sito finto e trascrizioni).

Si lancia a mano dalla radice del repository, solo quando gli esempi vanno cambiati:

    python3 -I fixtures/banche-dati/genera.py

Serve openpyxl, solo per scrivere l'XLSX: è un produttore di file Excel diverso dal lettore del
servizio, così la prova non legge file scritti dallo stesso codice che li legge.

Che cosa è vero e che cosa è inventato (docs/provenienze.md):
- AIFA: intestazioni e righe copiate senza cambiare un byte dai file AIFA letti il 18/11/2026
  (anagrafica delle confezioni e liste di classe A e H del 30/6/2026), il 19/11/2026 (lista di
  trasparenza del 16 novembre 2026, farmaci carenti aggiornati al 17/11/2026) e il 20/11/2026 (due
  confezioni dell'anagrafica e l'elenco dei registri e piani terapeutici attivi del 19/11/2026). Fonte: AIFA, dati aperti con licenza CC BY 4.0
  (https://www.aifa.gov.it/open-data). Le pagine HTML sono nostre.
- Regione Piemonte, DPC: la riga di DULAGLUTIDE è quella dell'elenco «Farmaci PHT - oggetto di
  DPC» aggiornato al 9/7/2026; il PDF del sito d'esempio è un estratto di prova scritto qui.
- ISTAT: le intestazioni e le due righe di Agliè e Airasca, lette il 18/11/2026 dal file ISTAT
  aggiornato al 21/02/2026.
- Tutto il resto (catalogo delle prestazioni, esenzioni) è inventato.
"""

import hashlib
import json
from pathlib import Path

from openpyxl import Workbook

QUI = Path(__file__).resolve().parent
SITO = QUI / "sito"
TRASCRIZIONI = QUI / "trascrizioni"


def scrivi(percorso: Path, dati: bytes) -> None:
    percorso.parent.mkdir(parents=True, exist_ok=True)
    percorso.write_bytes(dati)


def pdf_di_prova(titolo: str, *righe: str) -> bytes:
    """Un PDF di una pagina con un titolo e qualche riga; i riferimenti incrociati sono calcolati."""
    comandi = [f"BT /F1 14 Tf 72 760 Td ({titolo}) Tj ET"]
    comandi += [f"BT /F1 10 Tf 72 {730 - 16 * i} Td ({r}) Tj ET" for i, r in enumerate(righe)]
    testo = "\n".join(comandi).encode("latin-1")
    oggetti = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(testo)).encode() + b" >>\nstream\n" + testo + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    posizioni = []
    for i, corpo in enumerate(oggetti, start=1):
        posizioni.append(len(out))
        out += f"{i} 0 obj\n".encode() + corpo + b"\nendobj\n"
    inizio_xref = len(out)
    out += f"xref\n0 {len(oggetti) + 1}\n0000000000 65535 f \n".encode()
    for p in posizioni:
        out += f"{p:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(oggetti) + 1} /Root 1 0 R >>\nstartxref\n{inizio_xref}\n%%EOF\n".encode()
    return bytes(out)


# --------------------------------------------------------------------------- ISTAT

INTESTAZIONE_ISTAT = [
    "Codice Regione",
    "Codice dell'Unità territoriale sovracomunale  (valida a fini statistici)",
    "Codice Provincia (Storico)(1)",
    "Progressivo del Comune (2)",
    "Codice Comune formato alfanumerico",
    "Denominazione (Italiana e straniera)",
    "Denominazione in italiano",
    "Denominazione altra lingua",
    "Codice Ripartizione Geografica",
    "Ripartizione geografica",
    "Denominazione Regione",
    "Denominazione dell'Unità territoriale sovracomunale  (valida a fini statistici)",
    "Tipologia di Unità territoriale sovracomunale",
    "Flag Comune capoluogo di Provincia/Città metropolitana/libero consorzio",
    "Sigla automobilistica",
    "Codice Comune formato numerico",
    "Codice Comune numerico con 107 Province (dal 2017 al 2025)",
    "Codice Comune numerico con 110 Province (dal 2010 al 2016)",
    "Codice Comune numerico con 107 Province (dal 2006 al 2009)",
    "Codice Comune numerico con 103 Province (dal 1995 al 2005)",
    "Codice Catastale del Comune",
    "Codice NUTS1 2021",
    "Codice NUTS2 2021 (3)",
    "Codice NUTS3 2021",
    "Codice NUTS1 2024",
    "Codice NUTS2 2024 (3)",
    "Codice NUTS3 2024",
]


def riga_istat(progressivo: str, nome: str, numerico: int, catastale: str) -> list:
    return [
        "01", "201", "001", progressivo, f"001{progressivo}", nome, nome, None, 1, "Nord-ovest",
        "Piemonte", "Torino", 3, 0, "TO", numerico, numerico, numerico, numerico, numerico,
        catastale, "ITC", "ITC1", "ITC11", "ITC", "ITC1", "ITC11",
    ]


def genera_istat() -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "CODICI al 21_02_2026"
    ws.append(INTESTAZIONE_ISTAT)
    ws.append(riga_istat("001", "Agliè", 1001, "A074"))
    ws.append(riga_istat("002", "Airasca", 1002, "A109"))
    percorso = SITO / "istat" / "Elenco-comuni-italiani.xlsx"
    percorso.parent.mkdir(parents=True, exist_ok=True)
    wb.save(percorso)


# --------------------------------------------------------------------------- AIFA (estratti veri)

# Righe copiate dai file AIFA letti il 18/11/2026, nell'ordine e con la codifica dei file veri:
# anagrafica in utf-8 (tutta ASCII) con fine riga \n; liste di classe in cp1252 con \r\n, e
# nella classe H l'intestazione «Codice AIC» va a capo dentro le virgolette. Scelte: amlodipina,
# metformina e atorvastatina con un equivalente di marca; dulaglutide (in DPC, nota 100, piano);
# ceftriaxone in classe H; paracetamolo, che non è nelle liste di classe A e H; nella classe H due
# prezzi che non sono numeri («-» e il prezzo dell'ossigeno a metro cubo). Le ultime due righe
# vengono dal file scaricato il 20/11/2026: una confezione di ranitidina «Sospesa» (D205) e una di
# ENTRESTO (sacubitril/valsartan), che ha i piani terapeutici AIFA dell'elenco dei registri (D206).
ANAGRAFICA = [
    '"CODICE_AIC";"COD_FARMACO";"COD_CONFEZIONE";"DENOMINAZIONE";"DESCRIZIONE";"CODICE_DITTA";"RAGIONE_SOCIALE";"STATO_AMMINISTRATIVO";"TIPO_PROCEDURA";"FORMA";"CODICE_ATC";"PA_ASSOCIATI";"FORNITURA";"LINK_FI";"LINK_RCP"',
    '"038092019";"038092";"019";"AMLODIPINA DOC GENERICI";"5 MG COMPRESSE- 28 COMPRESSE IN BLISTER AL/PVC/PVDC";898;"DOC GENERICI SRL";"Autorizzata";"Procedura Mutuo riconoscimento o Decentrata";"Compressa";"C08CA01";"AMLODIPINA BESILATO";"Medicinali soggetti a prescrizione medica";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/898/farmaci/38092/stampati?ts=FI";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/898/farmaci/38092/stampati?ts=RCP"',
    '"037479060";"037479";"060";"AMLODIPINA EG";"5 MG COMPRESSE- 28 COMPRESSE IN BLISTER AL/PVC/PE/PVDC";1561;"EG S.P.A.";"Autorizzata";"Procedura Mutuo riconoscimento o Decentrata";"Compressa";"C08CA01";"AMLODIPINA BESILATO";"Medicinali soggetti a prescrizione medica";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/1561/farmaci/37479/stampati?ts=FI";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/1561/farmaci/37479/stampati?ts=RCP"',
    '"038548032";"038548";"032";"AMLODIPINA TEVA ITALIA";"5 MG COMPRESSE- 28 COMPRESSE IN BLISTER PVC/PVDC/AL";813;"TEVA ITALIA S.R.L.";"Autorizzata";"Procedura Mutuo riconoscimento o Decentrata";"Compressa";"C08CA01";"AMLODIPINA BESILATO";"Medicinali soggetti a prescrizione medica";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/813/farmaci/38548/stampati?ts=FI";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/813/farmaci/38548/stampati?ts=RCP"',
    '"027428010";"027428";"010";"NORVASC";"5 MG COMPRESSE- 28 COMPRESSE";4995;"VIATRIS PHARMA S.R.L.";"Autorizzata";"Procedura Nazionale";"Compressa";"C08CA01";"AMLODIPINA";"Medicinali soggetti a prescrizione medica";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/4995/farmaci/27428/stampati?ts=FI";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/4995/farmaci/27428/stampati?ts=RCP"',
    '"040592103";"040592";"103";"METFORMINA AUROBINDO";"500 MG COMPRESSE RIVESTITE CON FILM- 30 COMPRESSE IN BLISTER PVC/AL";3199;"AUROBINDO PHARMA (ITALIA) S.R.L.";"Autorizzata";"Procedura Mutuo riconoscimento o Decentrata";"Compressa rivestita con film";"A10BA02";"METFORMINA CLORIDRATO";"Medicinali soggetti a prescrizione medica";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/3199/farmaci/40592/stampati?ts=FI";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/3199/farmaci/40592/stampati?ts=RCP"',
    '"017758018";"017758";"018";"GLUCOPHAGE";"500 MG COMPRESSE RIVESTITE- 30 COMPRESSE";794;"BRUNO FARMACEUTICI S.P.A.";"Autorizzata";"Procedura Mutuo riconoscimento o Decentrata";"Compressa rivestita";"A10BA02";"METFORMINA CLORIDRATO";"Medicinali soggetti a prescrizione medica";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/794/farmaci/17758/stampati?ts=FI";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/794/farmaci/17758/stampati?ts=RCP"',
    '"048247023";"048247";"023";"ATORVASTATINA DOC GENERICS";"20 MG COMPRESSE RIVESTITE CON FILM- 30 COMPRESSE IN BLISTER PVC-PE-PVDC/AL";898;"DOC GENERICI SRL";"Autorizzata";"Procedura Mutuo riconoscimento o Decentrata";"Compressa rivestita con film";"C10AA05";"ATORVASTATINA";"Medicinali soggetti a prescrizione medica";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/898/farmaci/48247/stampati?ts=FI";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/898/farmaci/48247/stampati?ts=RCP"',
    '"033007042";"033007";"042";"TORVAST";"20- 30 COMPRESSE 20 MG";4995;"VIATRIS PHARMA S.R.L.";"Autorizzata";"Procedura Nazionale";"Compressa";"C10AA05";"ATORVASTATINA CALCIO TRIIDRATO";"Medicinali soggetti a prescrizione medica";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/4995/farmaci/33007/stampati?ts=FI";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/4995/farmaci/33007/stampati?ts=RCP"',
    '"043783075";"043783";"075";"TRULICITY";"1,5 MG  SOLUZIONE INIETTABILE - USO SOTTOCUTANEO - SIRINGA DI VETRO IN PENNA PRERIEMPITA - 4 PENNE";1230;"ELI LILLY NEDERLAND B.V.";"Autorizzata";"Procedura Centralizzata";"Soluzione iniettabile";"A10BJ05";"DULAGLUTIDE";"Medicinali soggetti a prescrizione medica";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/1230/farmaci/43783/stampati?ts=FI";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/1230/farmaci/43783/stampati?ts=RCP"',
    '"025202096";"025202";"096";"ROCEFIN";"1 G/10 ML POLVERE E SOLVENTE PER SOLUZIONE INIETTABILE PER USO ENDOVENOSO- 1 FLACONCINO POLVERE + 1 FIALA SOLVENTE DA 10 ML";108;"ROCHE S.P.A.";"Autorizzata";"Procedura Nazionale";"Polvere e solvente per soluzione iniettabile";"J01DD04";"CEFTRIAXONE SODICO";"Medicinali soggetti a prescrizione medica limitativa, da rinnovare volta per volta, vendibili al pubblico su prescrizione di centri ospedalieri o di specialisti";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/108/farmaci/25202/stampati?ts=FI";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/108/farmaci/25202/stampati?ts=RCP"',
    '"012745093";"012745";"093";"TACHIPIRINA";"500 MG COMPRESSE-20 COMPRESSE";219;"AZIENDE CHIMICHE RIUNITE ANGELINI FRANCESCO A.C.R.A.F. S.P.A.";"Autorizzata";"Procedura Nazionale";"Compressa";"N02BE01";"PARACETAMOLO";"Medicinali non soggetti a prescrizione medica ma non da banco";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/219/farmaci/12745/stampati?ts=FI";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/219/farmaci/12745/stampati?ts=RCP"',
    '"034471021";"034471";"021";"RANITIDINA DOC GENERICI";"300 MG COMPRESSE RIVESTITE CON FILM- 20 COMPRESSE";898;"DOC GENERICI SRL";"Sospesa";"Procedura Nazionale";"Compressa rivestita con film";"A02BA02";"RANITIDINA CLORIDRATO";"Medicinali soggetti a prescrizione medica";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/898/farmaci/34471/stampati?ts=FI";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/898/farmaci/34471/stampati?ts=RCP"',
    '"044558031";"044558";"031";"ENTRESTO";"49 MG/51 MG - COMPRESSA RIVESTITA CON FILM - USO ORALE - BLISTER (PVC/PVDC) - 56 COMPRESSE";4789;"NOVARTIS EUROPHARM LIMITED";"Autorizzata";"Procedura Centralizzata";"Compressa rivestita con film";"C09DX04";"VALSARTAN/SACUBITRIL";"Medicinali soggetti a prescrizione medica limitativa, vendibili al pubblico su prescrizione di centri ospedalieri o di specialisti";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/4789/farmaci/44558/stampati?ts=FI";"https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/4789/farmaci/44558/stampati?ts=RCP"',
]

CLASSE_A = [
    'Principio attivo;Descrizione gruppo;Denominazione e Confezione;Prezzo al pubblico €;Titolare AIC;AIC;Codice Gruppo Equivalenza;X=in lista di trasparenza Aifa 15/6/2026 ;Solo in lista di Regione:;Metri cubi ossigeno ',
    "Amlodipina;AMLODIPINA 5MG 28 UNITA' USO ORALE;AMLODIPINA*28 cpr 5 mg;3,74;DOC GENERICI Srl;038092019;DOB;X;;",
    "Amlodipina;AMLODIPINA 5MG 28 UNITA' USO ORALE;AMLODIPINA*28 cpr 5 mg;3,74;EG SpA;037479060;DOB;X;;",
    "Amlodipina;AMLODIPINA 5MG 28 UNITA' USO ORALE;AMLODIPINA*28 cpr 5 mg;3,74;TEVA ITALIA Srl;038548032;DOB;X;;",
    "Amlodipina;AMLODIPINA 5MG 28 UNITA' USO ORALE;NORVASC*28 cpr 5 mg;5,53;VIATRIS PHARMA Srl;027428010;DOB;X;;",
    "Metformina;METFORMINA 500MG 30 UNITA' USO ORALE;METFORMINA*30 cpr rivestite 500 mg;1,27;AUROBINDO PHARMA ITALIA Srl;040592103;A1A;X;;",
    "Metformina;METFORMINA 500MG 30 UNITA' USO ORALE;GLUCOPHAGE*30 cpr rivestite 500 mg;1,81;BRUNO FARMACEUTICI SpA;017758018;A1A;X;;",
    "Atorvastatina;ATORVASTATINA 20MG 30 UNITA' USO ORALE;ATORVASTATINA*30 cpr rivestite 20 mg;7,96;DOC GENERICI Srl;048247023;FTB;X;;",
    "Atorvastatina;ATORVASTATINA 20MG 30 UNITA' USO ORALE;TORVAST*30 cpr rivestite 20 mg;10,51;VIATRIS PHARMA Srl;033007042;FTB;X;;",
    "Dulaglutide;DULAGLUTIDE 1,5MG 4 UNITA' USO PARENTERALE;TRULICITY*4 penne preriempite SC 1,5 mg 0,5 ml;153,48;ELI LILLY NEDERLAND BV;043783075;BYO;;;",
]

CLASSE_H = [
    'Principio attivo;Descrizione gruppo;Denominazione e Confezione;Prezzo al pubblico €;Prezzo Ex-factory €;Prezzo massimo di cessione €;Titolare AIC;"Codice \nAIC";Codice Gruppo Equivalenza;Metri cubi ossigeno ',
    "Ceftriaxone;CEFTRIAXONE 1.000MG 1 UNITA' USO PARENTERALE EV;ROCEFIN*1 flaconcino EV 1 g + 1 fiala solv 10 ml;9,92;4,51;-;ROCHE SpA;025202096;AHU;",
    'Antitrombina III Umana;ANTITROMBINA III UMANA 1.000UI 20ML USO PARENTERALE;ANBINEX*1 flacone 1.000 UI + 1 siringa;-;-;330,00;INSTITUTO GRIFOLS S.A.;034330047;AEK;',
    'Ossigeno;OSSIGENO GAS CRIOGENICO 1.000 LT METRI CUBI SVOLTI 855,54;OSSIGENO*gas med criogenico contenitore fisso 1.000 litri;6,55/m³;4,20/m³;-;SAPIO PRODUZ.IDROGENO OSSIGENO;038901524;051;855,54',
]


# Lista di trasparenza ed elenco dei farmaci carenti, righe copiate dai file AIFA letti il
# 19/11/2026 (D202), in cp1252 con \r\n come i file veri: l'intestazione e le righe degli otto
# farmaci dimostrativi che hanno un equivalente; dei carenti, l'avvertenza, la data, l'intestazione
# e la riga di AMLODIPINA TEVA ITALIA, con la nota che va a capo dentro le virgolette (\n).
TRASPARENZA = [
    'Principio attivo;Confezione di riferimento;ATC;AIC;Farmaco;Confezione;Ditta;Prezzo riferimento SSN;Prezzo Pubblico 16 novembre 2026;Differenza;Nota;Codice gruppo equivalenza',
    'Amlodipina;28 UNITA\' 5 MG - USO ORALE;C08CA01;38092019;AMLODIPINA DOC GENERICI;"""5 MG COMPRESSE"" 28 COMPRESSE IN BLISTER AL/PVC/PVDC";DOC GENERICI S.R.L.;3,74 €;3,74 €;0,00 €;;DOB',
    'Amlodipina;28 UNITA\' 5 MG - USO ORALE;C08CA01;37479060;AMLODIPINA EG;"""5 MG COMPRESSE"" 28 CPR IN BLISTER AL/PVC//PE/PVCDC";EG S.P.A.;3,74 €;3,74 €;0,00 €;;DOB',
    'Amlodipina;28 UNITA\' 5 MG - USO ORALE;C08CA01;38548032;AMLODIPINA TEVA ITALIA;"""5 MG COMPRESSE"" 28 COMPRESSE";TEVA ITALIA S.R.L.;3,74 €;3,74 €;0,00 €;;DOB',
    'Amlodipina;28 UNITA\' 5 MG - USO ORALE;C08CA01;27428010;NORVASC;"""5 MG COMPRESSE"" 28 COMPRESSE";VIATRIS PHARMA S.R.L.;3,74 €;5,53 €;1,79 €;;DOB',
    'Atorvastatina;30 UNITA\' 20 MG - USO ORALE;C10AA05;48247023;ATORVASTATINA DOC GENERICS;"""20 MG COMPRESSE RIVESTITE CON FILM"" 30 COMPRESSE IN BLISTER PVC-PE-PVDC/AL";DOC GENERICI S.R.L.;7,96 €;7,96 €;0,00 €;;FTB',
    'Atorvastatina;30 UNITA\' 20 MG - USO ORALE;C10AA05;33007042;TORVAST;"""20 MG COMPRESSE RIVESTITE CON FILM"" 30 COMPRESSE";VIATRIS PHARMA S.R.L.;7,96 €;10,51 €;2,55 €;;FTB',
    'Metformina;30 UNITA\' 500 MG - USO ORALE;A10BA02;17758018;GLUCOPHAGE;"""500 MG COMPRESSE RIVESTITE"" 30 COMPRESSE";BRUNO FARMACEUTICI S.P.A.;1,27 €;1,81 €;0,54 €;;A1A',
    'Metformina;30 UNITA\' 500 MG - USO ORALE;A10BA02;40592103;METFORMINA AUROBINDO;"""500 MG COMPRESSE RIVESTITE CON FILM"" 30 COMPRESSE IN BLISTER PVC/AL";AUROBINDO PHARMA ITALIA S.R.L.;1,27 €;1,27 €;0,00 €;;A1A',
]

CARENTI = [
    'NB: I medicinali carenti, per i quali il Titolare AIC non abbia provveduto a comunicare la data effettiva di fine carenza, continueranno ad essere presenti nella “Lista dei farmaci temporaneamente carenti”, anche oltre la “data di fine presunta” inizialmente comunicata e indicata nella presente lista;;;;;;;;;;;;',
    'Elenco dei farmaci carenti aggiornato al 17/11/2026;;;;;;;;;;;;',
    'Nome medicinale;Codice AIC;Principio attivo;Forma farmaceutica e dosaggio;Titolare AIC;Data inizio;Fine presunta;Equivalente;Motivazioni;Suggerimenti/Indicazioni AIFA;Nota AIFA;Classe di rimborsabilità;Codice ATC',
    'AMLODIPINA TEVA ITALIA;038548032;AMLODIPINA BESILATO;"""5 MG COMPRESSE"" 28 COMPRESSE IN BLISTER PVC/PVDC/AL";TEVA ITALIA S.R.L.;02/11/2026;;Sì;Cessata commercializzazione definitiva;Per trattamento alternativo si consiglia di rivolgersi allo specialista o al M.M.G;"cessata commercializzazione definitiva relativa sia al canale retail che al canale ospedaliero:\n- canale retail: cessata commercializzazione a partire dal 02/11/2026\n- canale ospedaliero: cessata commercializzazione a partire dal 15/03/2027";A TOTALE CARICO DEL SSN.;C08CA01',
]


# Registri di monitoraggio e piani terapeutici AIFA attivi (D206): righe copiate dal file
# Elenco_Registri_PT_attivi_19.11.2026.csv letto il 20/11/2026, in utf-8 con BOM e \r\n come il file
# vero. L'intestazione; i due piani di ENTRESTO (adulti e pediatrico, ATC C09DX04); LEQVIO, con
# l'indicazione che va a capo dentro le virgolette; NEMLUVIO, con l'ATC scritto fra spazi; e tre
# righe della coda del file, vuote o quasi, che l'importazione salta.
REGISTRI = [
    '\ufeffScheda;Farmaco;Principio attivo;Codice ATC;Indicazione autorizzata;Indicazione rimborsata;Patologia;Tipologia di Monitoraggio;Stato del Monitoraggio;Area terapeutica;Data inizio monitoraggio;Tipologia MEA;Stato MEA;Data inizio MEA;Data fine validità MEA',
    'https://www.aifa.gov.it/documents/20142/3041382/PT_Entresto_pediatrico_04.09.2025.zip;ENTRESTO PEDIATRICO;Sacubitril valsartan;C09DX04;Entresto è indicato in bambini ed adolescenti da un anno di età in poi per il trattamento dell’insufficienza cardiaca sintomatica cronica con disfunzione sistolica ventricolare sinistra.;Entresto è indicato in bambini ed adolescenti da un anno di età in poi per il trattamento dell’insufficienza cardiaca sintomatica cronica con disfunzione sistolica ventricolare sinistra.;INSUFFICIENZA CARDIACA CRONICA SINTOMATICA;Piano Terapeutico;Attivo;Malattie del sistema circolatorio;04/09/2025;Nessuno;;;',
    'https://www.aifa.gov.it/documents/20142/2152764/Scheda_ENTRESTO_HF_07.12.2023.zip;ENTRESTO;Sacubitril e Valsartan;C09DX04;Entresto è indicato in pazienti adulti per il trattamento dell’insufficienza cardiaca sintomatica cronica con ridotta frazione di eiezione.;Entresto è indicato in pazienti adulti per il trattamento dell’insufficienza cardiaca sintomatica cronica con ridotta frazione di eiezione.;INSUFFICIENZA CARDIACA CRONICA SINTOMATICA;Piano Terapeutico;Attivo;Malattie del sistema circolatorio;12/03/2017;Nessuno;;;',
    'https://www.aifa.gov.it/documents/20142/3041382/LEQVIO-inclisiran_PTwb_semplificato_04.09.2025.zip;LEQVIO;inclisiran;C10AX16;"Leqvio è indicato in adulti con ipercolesterolemia primaria (eterozigote familiare e non familiare) o dislipidemia mista,\nin aggiunta alla dieta:\n· in associazione ad una statina o una statina con altre terapie ipolipemizzanti in pazienti non in grado di raggiungere gli obiettivi per l\'LDL-C con la dose massima tollerata di una statina, oppure\n- in monoterapia o in associazione ad altre terapie ipolipemizzanti in pazienti intolleranti alle statine o per i quali una statina è controindicata.";"Leqvio è indicato in adulti \n- in prevenzione primaria in pazienti di età ≤80 aa con ipercolesterolemia familiare eterozigote e livelli di LDL-C ≥130 mg/dL nonostante terapia da almeno 6 mesi con statina ad alta potenza alla massima dose tollerata + ezetimibe oppure con dimostrata intolleranza alle statine (vedere successivamente la definizione di intolleranza) e/o all\'ezetimibe;\n- in prevenzione secondaria in pazienti di età ≤80 aa con ipercolesterolemia familiare eterozigote o ipercolesterolemia non familiare o dislipidemia mista e livelli di LDL-C ≥70 mg/dL nonostante terapia da almeno 6 mesi con statina ad alta potenza alla massima dose tollerata + ezetimibe oppure dopo una sola rilevazione di C-LDL in caso di IMA recente (ultimi 12 mesi) o eventi CV multipli oppure con dimostrata intolleranza alle statine (vedere successivamente la definizione di intolleranza) e/o all\'ezetimibe.";IPERCOLESTEROLEMIA;Piano Terapeutico;Attivo;Malattie del sistema endocrino e disordini metabolici e nutrizionali;04/09/2025;Nessuno;;;',
    'https://www.aifa.gov.it/documents/20142/3730605/PT_web_NEMLUVIO_29.05.2026.zip;NEMLUVIO;Nemolizumab; D11AH12 ;Nemluvio è indicato per il trattamento di adulti con prurigo nodulare da moderata a grave eleggibili per la terapia sistemica;Nemluvio è indicato per il trattamento di adulti con prurigo nodulare (PN) grave eleggibili per la terapia sistemica che presentano tutte le seguenti caratteristiche:- valutazione Numerica del Picco di Prurito (Peak pruritus numeric rating scale -PP NRS) ≥ 7- numero di lesioni nodulari superiore o uguale a 20- Investigator’s global assessment (IGA) = 4 (SEVERE);PRURIGO NODULARE;Piano Terapeutico;Attivo;Malattie della pelle e del tessuto subcutaneo;29/05/2026;Nessuno;;;',
    ';;;;;;;;;;;;;;',
    ';;;;;;;;;;;Nessuno;;;',
    ';;quan;;;;;;;;;;;;',
]


def genera_aifa() -> None:
    pagina = """<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Liste dei farmaci (esempio)</title></head>
<body><h1>Liste dei farmaci (pagina d'esempio)</h1><ul>
<li><a href="/aifa/farmaci/confezioni_fornitura.csv">Anagrafica delle confezioni (estratto)</a></li>
<li><a href="/aifa/documents/20142/3815901/Classe-A_per_principio-attivo_30-6-2026.csv">Classe A (estratto)</a></li>
<li><a href="/aifa/documents/20142/3815901/Classe-H_per_principio-attivo_30-6-2026.csv">Classe H (estratto)</a></li>
<li><a href="/aifa/documents/20142/825643/Lista_farmaci_equivalenti.csv">Lista di trasparenza (estratto)</a></li>
<li><a href="/aifa/documents/20142/847339/elenco_medicinali_carenti.csv">Farmaci carenti (estratto)</a></li>
<li><a href="/aifa/documents/20142/3258518/Elenco_Registri_PT_attivi_19.11.2026.csv">Registri e piani terapeutici attivi (estratto)</a></li>
</ul></body></html>
"""
    scrivi(SITO / "aifa" / "liste-dei-farmaci.html", pagina.encode("utf-8"))
    scrivi(SITO / "aifa" / "farmaci" / "confezioni_fornitura.csv", ("\n".join(ANAGRAFICA) + "\n").encode("utf-8"))
    cartella = SITO / "aifa" / "documents" / "20142" / "3815901"
    scrivi(cartella / "Classe-A_per_principio-attivo_30-6-2026.csv", ("\r\n".join(CLASSE_A) + "\r\n").encode("cp1252"))
    scrivi(cartella / "Classe-H_per_principio-attivo_30-6-2026.csv", ("\r\n".join(CLASSE_H) + "\r\n").encode("cp1252"))
    documenti = SITO / "aifa" / "documents" / "20142"
    scrivi(documenti / "825643" / "Lista_farmaci_equivalenti.csv", ("\r\n".join(TRASPARENZA) + "\r\n").encode("cp1252"))
    scrivi(documenti / "847339" / "elenco_medicinali_carenti.csv", ("\r\n".join(CARENTI) + "\r\n").encode("cp1252"))
    scrivi(documenti / "3258518" / "Elenco_Registri_PT_attivi_19.11.2026.csv", ("\r\n".join(REGISTRI) + "\r\n").encode("utf-8"))


# --------------------------------------------------------------------------- Regione Piemonte (PDF di prova)

def pagina_con_link(titolo: str, href: str) -> bytes:
    return (f'<!doctype html><html lang="it"><head><meta charset="utf-8"><title>{titolo}</title></head>'
            f'<body><h1>{titolo}</h1><p><a href="{href}">Scarica il documento di prova</a></p></body></html>\n').encode("utf-8")


def genera_piemonte() -> dict[str, str]:
    pdf = {
        "farmaci_pht_dpc.pdf": pdf_di_prova(
            "Farmaci PHT - oggetto di DPC (estratto di prova)",
            "Regione Piemonte, ultimo aggiornamento 9 luglio 2026",
            "PRINCIPIO ATTIVO | ATC | NOTA AIFA | PRESCRIZIONE CON PT/SCHEDA",
            "DULAGLUTIDE (14) | A10BJ05 | 100 | PT elettronico - Sistema TS",
        ),
        "catalogo_prova_allegato_c.pdf": pdf_di_prova("Catalogo di prova delle prestazioni"),
        "esenzioni_prestazioni_prova.pdf": pdf_di_prova("Esenzioni e prestazioni di prova"),
    }
    scrivi(SITO / "piemonte" / "dpc.html", pagina_con_link("DPC di prova", "/piemonte/media/57684/download"))
    scrivi(SITO / "piemonte" / "media" / "57684" / "download.pdf", pdf["farmaci_pht_dpc.pdf"])
    scrivi(SITO / "piemonte" / "catalogo.html", pagina_con_link("Catalogo di prova", "/piemonte/attach/catalogo_prova_allegato_c.pdf"))
    scrivi(SITO / "piemonte" / "attach" / "catalogo_prova_allegato_c.pdf", pdf["catalogo_prova_allegato_c.pdf"])
    scrivi(SITO / "piemonte" / "esenzioni_prestazioni_prova.pdf", pdf["esenzioni_prestazioni_prova.pdf"])
    return {k: hashlib.sha256(v).hexdigest() for k, v in pdf.items()}


# --------------------------------------------------------------------------- trascrizioni

def trascrizione(nome: str, righe: list[str], scheda: dict) -> None:
    scrivi(TRASCRIZIONI / f"{nome}.csv", ("\n".join(righe) + "\n").encode("utf-8"))
    base = {"trascritto_da": "Persona di prova", "trascritto_il": "2026-11-18",
            "controllato_da": "Seconda persona di prova"}
    (TRASCRIZIONI / f"{nome}.json").write_text(
        json.dumps({**scheda, **base}, ensure_ascii=False, indent=2) + "\n", "utf-8")


def genera_trascrizioni(impronte: dict[str, str]) -> None:
    trascrizione("piemonte_dpc/farmaci_pht_dpc", [
        "principio_attivo;atc;nota_aifa;piano_terapeutico",
        "DULAGLUTIDE;A10BJ05;100;sì",
    ], {"tipo": "farmaci_dpc", "fonte": "piemonte_dpc", "chiave": "farmaci_pht_dpc.pdf",
        "sha256_origine": impronte["farmaci_pht_dpc.pdf"],
        "atto": "Farmaci PHT - oggetto di DPC, aggiornamento del 9/7/2026, estratto di prova",
        "in_vigore_dal": "2026-07-09",
        "nota": ("Riga dell'elenco della Regione Piemonte letto il 18/11/2026 (PDF di 13 pagine, SHA-256 "
                 "8c7d006876a2b953cf09dd4738a1f7198cdc87d7b392eb55a05512c60d9e1fed): «DULAGLUTIDE (14)», "
                 "A10BJ05, nota 100, «PT elettronico - Sistema TS», qui «sì». La nota (14) dell'elenco "
                 "riguarda le associazioni con gli SGLT2i.")})
    trascrizione("piemonte_catalogo/catalogo-precedente", [
        "codice_regionale;codice_nomenclatore;descrizione;branca;tariffa;note",
        "89.7;89.7;Visita di prova (catalogo precedente);Branca di prova;;",
    ], {"tipo": "prestazioni", "serie": "catalogo-piemonte", "fonte": None, "chiave": None,
        "sha256_origine": None, "atto": "Catalogo di prova precedente", "in_vigore_dal": "2024-12-30"})
    trascrizione("piemonte_catalogo/catalogo_prova_allegato_c", [
        "codice_regionale;codice_nomenclatore;descrizione;branca;tariffa;note",
        "89.7;89.7;Visita di prova;Branca di prova;20,66;",
        "PROVA.02;;Esame di prova;Laboratorio di prova;;Nota di prova",
    ], {"tipo": "prestazioni", "serie": "catalogo-piemonte", "fonte": "piemonte_catalogo",
        "chiave": "catalogo_prova_allegato_c.pdf", "sha256_origine": impronte["catalogo_prova_allegato_c.pdf"],
        "atto": "Catalogo di prova delle prestazioni", "in_vigore_dal": "2026-10-30"})
    trascrizione("esenzioni/catalogo-esenzioni", [
        "codice;descrizione",
        "DEMO;Esenzione dimostrativa",
        "T01;Esenzione di prova per patologia",
        "T02;Altra esenzione di prova",
    ], {"tipo": "esenzioni", "fonte": None, "chiave": None, "sha256_origine": None,
        "atto": "Elenco di prova delle esenzioni", "in_vigore_dal": "2026-01-01"})
    trascrizione("piemonte_esenzioni_prestazioni/esenzioni_prestazioni_prova", [
        "esenzione;prestazione",
        "T01;89.7",
    ], {"tipo": "esenzioni_prestazioni", "fonte": "piemonte_esenzioni_prestazioni",
        "chiave": "esenzioni_prestazioni_prova.pdf", "sha256_origine": impronte["esenzioni_prestazioni_prova.pdf"],
        "atto": "Esenzioni e prestazioni di prova", "in_vigore_dal": "2026-01-01"})


if __name__ == "__main__":
    genera_istat()
    genera_aifa()
    genera_trascrizioni(genera_piemonte())
    print(f"File d'esempio scritti in {SITO} e {TRASCRIZIONI}")
