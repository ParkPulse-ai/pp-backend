// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract HederaVoting {
    struct Proposal {
        uint256 proposalId;
        string parkName;
        string message;
        uint256 parkSize;
        string chatTopicHistory;
        address creator;
        uint256 yesVotes;
        uint256 noVotes;
        uint256 deadline;
        bool exists;
    }
    
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => address[]) public voters; // store all voter addresses for each proposal
    uint256 public proposalCount; // keeps track of latest proposalId
    
    // Events
    event ProposalCreated(
        uint256 proposalId,
        string parkName,
        string message,
        uint256 parkSize,
        string chatTopicHistory,
        address creator,
        uint256 deadline
    );
    
    event VoteCast(uint256 proposalId, address voter, bool vote);
    
    /// @notice Create a new proposal
    function createProposal(
        string memory _parkName,
        string memory _message,
        uint256 _parkSize,
        string memory _chatTopicHistory,
        uint256 _deadline
    ) external {
        require(_deadline > block.timestamp, "Deadline must be in the future");
        proposalCount++; // auto-increment
        uint256 newProposalId = proposalCount;
        
        proposals[newProposalId] = Proposal({
            proposalId: newProposalId,
            parkName: _parkName,
            message: _message,
            parkSize: _parkSize,
            chatTopicHistory: _chatTopicHistory,
            creator: msg.sender,
            yesVotes: 0,
            noVotes: 0,
            deadline: _deadline,
            exists: true
        });
        
        emit ProposalCreated(
            newProposalId,
            _parkName,
            _message,
            _parkSize,
            _chatTopicHistory,
            msg.sender,
            _deadline
        );
    }
    
    /// @notice Vote on a proposal on behalf of a given address
    /// @param _proposalId The ID of the proposal to vote on
    /// @param _support true for YES vote, false for NO vote
    /// @param _voter The address being recorded as the voter
    function vote(uint256 _proposalId, bool _support, address _voter) external {
        Proposal storage p = proposals[_proposalId];
        require(p.exists, "Proposal does not exist");
        require(block.timestamp <= p.deadline, "Voting period has ended");

        if (_support) {
            p.yesVotes += 1;
        } else {
            p.noVotes += 1;
        }

        // store voter address
        voters[_proposalId].push(_voter);

        emit VoteCast(_proposalId, _voter, _support);
    }

    /// @notice Get proposal details
    function getProposal(uint256 _proposalId)
        external
        view
        returns (
            uint256 proposalId,
            string memory parkName,
            string memory message,
            uint256 parkSize,
            string memory chatTopicHistory,
            address creator,
            uint256 yesVotes,
            uint256 noVotes,
            uint256 deadline,
            bool active
        )
    {
        Proposal memory p = proposals[_proposalId];
        require(p.exists, "Proposal does not exist");
        bool isActiveNow = block.timestamp <= p.deadline;
        
        return (
            p.proposalId,
            p.parkName,
            p.message,
            p.parkSize,
            p.chatTopicHistory,
            p.creator,
            p.yesVotes,
            p.noVotes,
            p.deadline,
            isActiveNow
        );
    }

    /// @notice Get all voters for a proposal
    function getVoters(uint256 _proposalId) external view returns (address[] memory) {
        return voters[_proposalId];
    }

    /// @notice Get all active proposal IDs
    function getActiveProposals() external view returns (uint256[] memory) {
        uint256[] memory tempActive = new uint256[](proposalCount);
        uint256 activeCount = 0;
        
        for (uint256 i = 1; i <= proposalCount; i++) {
            if (proposals[i].exists && block.timestamp <= proposals[i].deadline) {
                tempActive[activeCount] = i;
                activeCount++;
            }
        }
        
        uint256[] memory activeProposals = new uint256[](activeCount);
        for (uint256 j = 0; j < activeCount; j++) {
            activeProposals[j] = tempActive[j];
        }
        
        return activeProposals;
    }
    
    /// @notice Get total number of proposals created
    function getTotalProposals() external view returns (uint256) {
        return proposalCount;
    }
}
