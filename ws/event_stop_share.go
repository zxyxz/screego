package ws

import (
	"bytes"

	"github.com/screego/server/ws/outgoing"
)

func init() {
	register("stopshare", func() Event {
		return &StopShare{}
	})
}

type StopShare struct{}

func (e *StopShare) Execute(rooms *Rooms, current ClientInfo) error {
	room, err := rooms.CurrentRoom(current)
	if err != nil {
		return err
	}

	room.Users[current.ID].Streaming = false
	if room.Live != nil && room.Live.HostID == current.ID {
		rooms.live.Stop(room.ID)
		room.Live = nil
	}
	for id, session := range room.Sessions {
		if bytes.Equal(session.Host.Bytes(), current.ID.Bytes()) {
			client, ok := room.Users[session.Client]
			if ok {
				client.WriteTimeout(outgoing.EndShare(id))
			}
			room.closeSession(rooms, id)
		}
	}

	room.notifyInfoChanged()
	return nil
}
