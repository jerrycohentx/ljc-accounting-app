import React, { createContext, useContext, useEffect, useState } from 'react';
import { entityAPI } from '../services/api';

const EntityCtx = createContext(null);

export function EntityProvider({ children }) {
  const [entities, setEntities] = useState([]);
  const [entityId, setEntityIdState] = useState(localStorage.getItem('entityId') || 'ent-ljc');

  useEffect(() => {
    entityAPI.list()
      .then((r) => {
        const list = Array.isArray(r.data) ? r.data : (r.data?.data || []);
        setEntities(list);
        // if stored entity isn't in list, default to first
        if (list.length && !list.find((e) => e.id === entityId)) {
          setEntityId(list[0].id);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setEntityId = (id) => {
    localStorage.setItem('entityId', id);
    setEntityIdState(id);
  };

  const current = entities.find((e) => e.id === entityId) || null;

  return (
    <EntityCtx.Provider value={{ entities, entityId, setEntityId, current }}>
      {children}
    </EntityCtx.Provider>
  );
}

export const useEntity = () => useContext(EntityCtx);
