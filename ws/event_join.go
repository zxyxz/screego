package ws

import (
	"fmt"
)

func init() {
	register("join", func() Event {
		return &Join{}
	})
}

type Join struct {
	ID       string `json:"id"`
	UserName string `json:"username,omitempty"`
}

func (e *Join) Execute(rooms *Rooms, current ClientInfo) error {
	if rooms.connected[current.ID] != "" {
		return fmt.Errorf("cannot join room, you are already in one")
	}

	room, ok := rooms.Rooms[e.ID]
	if !ok {
		return fmt.Errorf("room with id %s does not exist", e.ID)
	}
	name := e.UserName
	if current.Authenticated {
		name = current.AuthenticatedUser
	}
	if name == "" {
		name = rooms.RandUserName()
	}

	room.Users[current.ID] = &User{
		ID:        current.ID,
		Name:      name,
		Streaming: false,
		Owner:     false,
		Addr:      current.Addr,
		_write:    current.Write,
	}
	rooms.connected[current.ID] = room.ID
	room.notifyInfoChanged()
	usersJoinedTotal.Inc()

	v4, v6, err := rooms.config.TurnIPProvider.Get()
	if err != nil {
		return err
	}

	for _, user := range room.Users {
		if current.ID == user.ID || !user.Streaming {
			continue
		}
		// Live shares bypass WebRTC entirely: the joiner receives the relayed
		// stream via the viewer token in the room info instead.
		if room.Live != nil && room.Live.HostID == user.ID {
			continue
		}
		room.newSession(user.ID, current.ID, rooms, v4, v6)
	}

	return nil
}
