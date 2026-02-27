'use client';

import { useEffect, useState } from 'react';
import {
  onSnapshot,
  Query,
  DocumentData,
  QuerySnapshot,
  FirestoreError,
} from 'firebase/firestore';
import { errorEmitter } from '@/firebase/error-emitter';
import { FirestorePermissionError } from '@/firebase/errors';

export function useCollection<T = DocumentData>(query: Query<T> | null) {
  const [data, setData] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FirestoreError | null>(null);

  useEffect(() => {
    if (!query) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const unsubscribe = onSnapshot(
      query,
      (snapshot: QuerySnapshot<T>) => {
        setData(snapshot.docs.map((doc) => doc.data()));
        setLoading(false);
      },
      async (err) => {
        if (err.code === 'permission-denied') {
          // Attempt to get a more descriptive path from the query object if available
          // In some SDK versions, query.path or internal _query property might exist,
          // but we'll default to a more useful generic label.
          const permissionError = new FirestorePermissionError({
            path: (query as any)._query?.path?.toString() || 'collection/query',
            operation: 'list',
          });
          errorEmitter.emit('permission-error', permissionError);
        }
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [query]);

  return { data, loading, error };
}
