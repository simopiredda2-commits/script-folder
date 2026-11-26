-- La ricetta SSN va al servizio della regione dello studio (D300): il valore prende un nome che non
-- è di una regione. Si rinomina, così le chiamate già registrate restano come sono.
ALTER TYPE "public"."gateway_system" RENAME VALUE 'sar' TO 'regional';
