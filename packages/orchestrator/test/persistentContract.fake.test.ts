import { describePersistentContract } from './contract/persistentContract';
import { fakePersistentHarness } from './contract/fakePersistentHarness';

describePersistentContract('fake', fakePersistentHarness);
